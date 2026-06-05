using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using x_gpt.Data;
using x_gpt.Models;
using x_gpt.Services;

var builder = WebApplication.CreateBuilder(args);
var streamJsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.Configure<OllamaOptions>(builder.Configuration.GetSection("Ollama"));
builder.Services.Configure<StorageOptions>(builder.Configuration.GetSection("Storage"));

var storageOptions = builder.Configuration.GetSection("Storage").Get<StorageOptions>() ?? new StorageOptions();
Directory.CreateDirectory(storageOptions.DataDirectory);
var databasePath = Path.Combine(storageOptions.DataDirectory, storageOptions.DatabaseFileName);

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite($"Data Source={databasePath}"));

builder.Services.AddHttpClient<OllamaClient>((services, client) =>
{
    var options = services.GetRequiredService<Microsoft.Extensions.Options.IOptions<OllamaOptions>>().Value;
    client.BaseAddress = new Uri(options.BaseUrl);
    client.Timeout = Timeout.InfiniteTimeSpan;
});
builder.Services.AddScoped<ChatService>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.EnsureCreatedAsync();
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/ollama/models", async (OllamaClient ollama, CancellationToken cancellationToken) =>
{
    try
    {
        var models = await ollama.ListModelsAsync(cancellationToken);
        return Results.Ok(models.Select(model => new OllamaModelDto(model.Name, model.Model)));
    }
    catch (OllamaException error)
    {
        return Results.Problem(
            title: "Ollama request failed",
            detail: $"Ollama returned {(int)error.StatusCode}: {error.Message}",
            statusCode: StatusCodes.Status502BadGateway);
    }
});

app.MapGet("/api/projects", async (AppDbContext db, CancellationToken cancellationToken) =>
{
    var projects = await db.Projects
        .Include(project => project.Branches)
        .ToListAsync(cancellationToken);

    return Results.Ok(projects
        .OrderByDescending(project => project.UpdatedAt)
        .Select(ProjectDto.From));
});

app.MapPost("/api/projects", async (
    CreateProjectRequest request,
    ChatService chatService,
    CancellationToken cancellationToken) =>
{
    var name = NormalizeName(request.Name, "Untitled Project");
    var project = await chatService.CreateProjectAsync(name, request.ContextMode ?? ContextMode.BranchOnly, cancellationToken);

    return Results.Created($"/api/projects/{project.Id}", ProjectDto.From(project));
});

app.MapGet("/api/projects/{projectId:guid}", async (
    Guid projectId,
    AppDbContext db,
    CancellationToken cancellationToken) =>
{
    var project = await db.Projects
        .Include(item => item.Branches)
        .FirstOrDefaultAsync(item => item.Id == projectId, cancellationToken);

    return project is null ? Results.NotFound() : Results.Ok(ProjectDto.From(project));
});

app.MapPost("/api/projects/{projectId:guid}/branches", async (
    Guid projectId,
    CreateBranchRequest request,
    ChatService chatService,
    CancellationToken cancellationToken) =>
{
    try
    {
        var branch = await chatService.CreateBranchAsync(
            projectId,
            NormalizeName(request.Name, "new branch"),
            request.ParentBranchId,
            request.ParentMessageId,
            cancellationToken);

        return Results.Created($"/api/branches/{branch.Id}/messages", BranchDto.From(branch));
    }
    catch (InvalidOperationException error)
    {
        return Results.BadRequest(new { error = error.Message });
    }
});

app.MapPut("/api/branches/{branchId:guid}/project", async (
    Guid branchId,
    MoveBranchRequest request,
    ChatService chatService,
    CancellationToken cancellationToken) =>
{
    try
    {
        var branch = await chatService.MoveBranchAsync(branchId, request.ProjectId, cancellationToken);
        return Results.Ok(BranchDto.From(branch));
    }
    catch (InvalidOperationException error)
    {
        return Results.BadRequest(new { error = error.Message });
    }
});

app.MapGet("/api/branches/{branchId:guid}/messages", async (
    Guid branchId,
    AppDbContext db,
    CancellationToken cancellationToken) =>
{
    var branchExists = await db.Branches.AnyAsync(branch => branch.Id == branchId, cancellationToken);
    if (!branchExists)
    {
        return Results.NotFound();
    }

    var messages = await db.Messages
        .Where(message => message.BranchId == branchId)
        .OrderBy(message => message.Sequence)
        .ToListAsync(cancellationToken);

    return Results.Ok(messages.Select(MessageDto.From));
});

app.MapPost("/api/branches/{branchId:guid}/messages", async (
    Guid branchId,
    SendMessageRequest request,
    ChatService chatService,
    HttpContext httpContext,
    CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(request.Content))
    {
        await Results.BadRequest(new { error = "Message content is required." }).ExecuteAsync(httpContext);
        return;
    }

    try
    {
        httpContext.Response.ContentType = "application/x-ndjson; charset=utf-8";

        await foreach (var chunk in chatService.StreamMessageAsync(branchId, request.Content.Trim(), request.Model, cancellationToken))
        {
            await httpContext.Response.WriteAsync(JsonSerializer.Serialize(chunk, streamJsonOptions), cancellationToken);
            await httpContext.Response.WriteAsync("\n", cancellationToken);
            await httpContext.Response.Body.FlushAsync(cancellationToken);
        }
    }
    catch (OllamaException error)
    {
        if (httpContext.Response.HasStarted)
        {
            await httpContext.Response.WriteAsync($"\n\n[Ollama error: {error.Message}]", cancellationToken);
            return;
        }

        await Results.Problem(
                title: "Ollama request failed",
                detail: $"Model '{error.Model}' returned {(int)error.StatusCode}: {error.Message}",
                statusCode: StatusCodes.Status502BadGateway)
            .ExecuteAsync(httpContext);
    }
    catch (InvalidOperationException error)
    {
        if (httpContext.Response.HasStarted)
        {
            await httpContext.Response.WriteAsync($"\n\n[Error: {error.Message}]", cancellationToken);
            return;
        }

        await Results.BadRequest(new { error = error.Message }).ExecuteAsync(httpContext);
    }
});

app.MapDelete("/api/branches/{branchId:guid}/messages/{messageId:guid}/turn", async (
    Guid branchId,
    Guid messageId,
    ChatService chatService,
    CancellationToken cancellationToken) =>
{
    try
    {
        await chatService.DeleteTurnAsync(branchId, messageId, cancellationToken);
        return Results.NoContent();
    }
    catch (InvalidOperationException error)
    {
        return Results.BadRequest(new { error = error.Message });
    }
});

app.MapGet("/api/projects/{projectId:guid}/summaries", async (
    Guid projectId,
    AppDbContext db,
    CancellationToken cancellationToken) =>
{
    var summaries = await db.Summaries
        .Where(summary => summary.ProjectId == projectId)
        .ToListAsync(cancellationToken);

    return Results.Ok(summaries
        .OrderByDescending(summary => summary.CreatedAt)
        .Select(SummaryDto.From));
});

app.MapPost("/api/branches/{branchId:guid}/summaries", async (
    Guid branchId,
    CreateSummaryRequest request,
    ChatService chatService,
    CancellationToken cancellationToken) =>
{
    try
    {
        var summary = await chatService.CreateSummaryAsync(branchId, request.Scope ?? SummaryScope.Branch, cancellationToken);
        return Results.Ok(SummaryDto.From(summary));
    }
    catch (OllamaException error)
    {
        return Results.Problem(
            title: "Ollama request failed",
            detail: $"Model '{error.Model}' returned {(int)error.StatusCode}: {error.Message}",
            statusCode: StatusCodes.Status502BadGateway);
    }
    catch (InvalidOperationException error)
    {
        return Results.BadRequest(new { error = error.Message });
    }
});

app.MapFallbackToFile("index.html");

await app.RunAsync();

static string NormalizeName(string? name, string fallback)
{
    var normalized = name?.Trim();
    return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
}

public sealed record CreateProjectRequest(string? Name, ContextMode? ContextMode);

public sealed record CreateBranchRequest(string? Name, Guid? ParentBranchId, Guid? ParentMessageId);

public sealed record MoveBranchRequest(Guid ProjectId);

public sealed record SendMessageRequest(string Content, string? Model);

public sealed record OllamaModelDto(string Name, string Model);

public sealed record CreateSummaryRequest(SummaryScope? Scope);

public sealed record ChatTurnDto(MessageDto UserMessage, MessageDto AssistantMessage);

public sealed record ProjectDto(
    Guid Id,
    string Name,
    ContextMode ContextMode,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    IReadOnlyList<BranchDto> Branches)
{
    public static ProjectDto From(ChatProject project)
    {
        return new ProjectDto(
            project.Id,
            project.Name,
            project.ContextMode,
            project.CreatedAt,
            project.UpdatedAt,
            project.Branches
                .OrderBy(branch => branch.CreatedAt)
                .Select(BranchDto.From)
                .ToList());
    }
}

public sealed record BranchDto(
    Guid Id,
    Guid ProjectId,
    string Name,
    Guid? ParentBranchId,
    Guid? ParentMessageId,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt)
{
    public static BranchDto From(ChatBranch branch)
    {
        return new BranchDto(
            branch.Id,
            branch.ProjectId,
            branch.Name,
            branch.ParentBranchId,
            branch.ParentMessageId,
            branch.CreatedAt,
            branch.UpdatedAt);
    }
}

public sealed record MessageDto(
    Guid Id,
    Guid BranchId,
    string Role,
    string Content,
    int Sequence,
    DateTimeOffset CreatedAt)
{
    public static MessageDto From(ChatMessage message)
    {
        return new MessageDto(
            message.Id,
            message.BranchId,
            message.Role,
            message.Content,
            message.Sequence,
            message.CreatedAt);
    }
}

public sealed record SummaryDto(
    Guid Id,
    Guid ProjectId,
    Guid? BranchId,
    SummaryScope Scope,
    string Content,
    string Model,
    int? FromSequence,
    int? ToSequence,
    DateTimeOffset CreatedAt)
{
    public static SummaryDto From(ContextSummary summary)
    {
        return new SummaryDto(
            summary.Id,
            summary.ProjectId,
            summary.BranchId,
            summary.Scope,
            summary.Content,
            summary.Model,
            summary.FromSequence,
            summary.ToSequence,
            summary.CreatedAt);
    }
}
