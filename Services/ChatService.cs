using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using System.Runtime.CompilerServices;
using System.Text;
using x_gpt.Data;
using x_gpt.Models;

namespace x_gpt.Services;

public sealed class ChatService(AppDbContext db, OllamaClient ollama, IOptions<OllamaOptions> ollamaOptions)
{
    private const int RecentContextMessageLimit = 40;
    private const int SummarySourceMessageLimit = 200;
    private readonly OllamaOptions _ollamaOptions = ollamaOptions.Value;

    public async Task<ChatProject> CreateProjectAsync(string name, ContextMode contextMode, CancellationToken cancellationToken)
    {
        var project = new ChatProject
        {
            Name = name,
            ContextMode = contextMode
        };

        project.Branches.Add(new ChatBranch
        {
            Name = "main",
            ProjectId = project.Id
        });

        db.Projects.Add(project);
        await db.SaveChangesAsync(cancellationToken);

        return project;
    }

    public async Task<ChatBranch> CreateBranchAsync(
        Guid projectId,
        string name,
        Guid? parentBranchId,
        Guid? parentMessageId,
        CancellationToken cancellationToken)
    {
        var projectExists = await db.Projects.AnyAsync(project => project.Id == projectId, cancellationToken);
        if (!projectExists)
        {
            throw new InvalidOperationException("Project not found.");
        }

        if (parentBranchId.HasValue)
        {
            var parentExists = await db.Branches.AnyAsync(
                branch => branch.Id == parentBranchId && branch.ProjectId == projectId,
                cancellationToken);

            if (!parentExists)
            {
                throw new InvalidOperationException("Parent branch not found in this project.");
            }
        }

        if (parentMessageId.HasValue)
        {
            var parentMessageExists = await db.Messages
                .Include(message => message.Branch)
                .AnyAsync(
                    message => message.Id == parentMessageId && message.Branch != null && message.Branch.ProjectId == projectId,
                    cancellationToken);

            if (!parentMessageExists)
            {
                throw new InvalidOperationException("Parent message not found in this project.");
            }
        }

        var branch = new ChatBranch
        {
            ProjectId = projectId,
            Name = name,
            ParentBranchId = parentBranchId,
            ParentMessageId = parentMessageId
        };

        db.Branches.Add(branch);
        await TouchProjectAsync(projectId, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);

        return branch;
    }

    public async Task<ChatBranch> MoveBranchAsync(Guid branchId, Guid projectId, CancellationToken cancellationToken)
    {
        var branch = await db.Branches.FindAsync([branchId], cancellationToken);
        if (branch is null)
        {
            throw new InvalidOperationException("Branch not found.");
        }

        var projectExists = await db.Projects.AnyAsync(project => project.Id == projectId, cancellationToken);
        if (!projectExists)
        {
            throw new InvalidOperationException("Target project not found.");
        }

        branch.ProjectId = projectId;
        branch.ParentBranchId = null;
        branch.ParentMessageId = null;
        branch.UpdatedAt = DateTimeOffset.UtcNow;

        await TouchProjectAsync(projectId, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);

        return branch;
    }

    public async Task<ChatTurnResult> SendMessageAsync(Guid branchId, string content, CancellationToken cancellationToken)
    {
        var branch = await db.Branches
            .Include(item => item.Project)
            .FirstOrDefaultAsync(item => item.Id == branchId, cancellationToken);

        if (branch?.Project is null)
        {
            throw new InvalidOperationException("Branch not found.");
        }

        var nextSequence = await GetNextSequenceAsync(branchId, cancellationToken);
        var userMessage = new ChatMessage
        {
            BranchId = branchId,
            Role = "user",
            Content = content,
            Sequence = nextSequence
        };

        db.Messages.Add(userMessage);
        branch.UpdatedAt = DateTimeOffset.UtcNow;
        branch.Project.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        var ollamaMessages = await BuildContextAsync(branch, cancellationToken);
        var answer = await ollama.ChatAsync(ollamaMessages, cancellationToken);

        var assistantMessage = new ChatMessage
        {
            BranchId = branchId,
            Role = "assistant",
            Content = answer,
            Sequence = nextSequence + 1
        };

        db.Messages.Add(assistantMessage);
        branch.UpdatedAt = DateTimeOffset.UtcNow;
        branch.Project.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        return new ChatTurnResult(userMessage, assistantMessage);
    }

    public async IAsyncEnumerable<ChatStreamChunk> StreamMessageAsync(
        Guid branchId,
        string content,
        string? model,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var branch = await db.Branches
            .Include(item => item.Project)
            .FirstOrDefaultAsync(item => item.Id == branchId, cancellationToken);

        if (branch?.Project is null)
        {
            throw new InvalidOperationException("Branch not found.");
        }

        var nextSequence = await GetNextSequenceAsync(branchId, cancellationToken);
        var userMessage = new ChatMessage
        {
            BranchId = branchId,
            Role = "user",
            Content = content,
            Sequence = nextSequence
        };

        db.Messages.Add(userMessage);
        branch.UpdatedAt = DateTimeOffset.UtcNow;
        branch.Project.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        var ollamaMessages = await BuildContextAsync(branch, cancellationToken);
        var answer = new StringBuilder();

        await foreach (var chunk in ollama.StreamChatAsync(ollamaMessages, model, cancellationToken))
        {
            if (chunk.Type == "content")
            {
                answer.Append(chunk.Text);
            }

            yield return new ChatStreamChunk(chunk.Type, chunk.Text);
        }

        var assistantMessage = new ChatMessage
        {
            BranchId = branchId,
            Role = "assistant",
            Content = answer.ToString().Trim(),
            Sequence = nextSequence + 1
        };

        db.Messages.Add(assistantMessage);
        branch.UpdatedAt = DateTimeOffset.UtcNow;
        branch.Project.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteTurnAsync(Guid branchId, Guid messageId, CancellationToken cancellationToken)
    {
        var target = await db.Messages
            .Include(message => message.Branch)
            .ThenInclude(branch => branch!.Project)
            .FirstOrDefaultAsync(message => message.Id == messageId && message.BranchId == branchId, cancellationToken);

        if (target?.Branch?.Project is null)
        {
            throw new InvalidOperationException("Message not found.");
        }

        var messagesToDelete = new List<ChatMessage> { target };

        if (target.Role == "assistant")
        {
            var question = await db.Messages
                .Where(message => message.BranchId == branchId && message.Role == "user" && message.Sequence < target.Sequence)
                .OrderByDescending(message => message.Sequence)
                .FirstOrDefaultAsync(cancellationToken);

            if (question is not null)
            {
                messagesToDelete.Add(question);
            }
        }
        else if (target.Role == "user")
        {
            var answer = await db.Messages
                .Where(message => message.BranchId == branchId && message.Role == "assistant" && message.Sequence > target.Sequence)
                .OrderBy(message => message.Sequence)
                .FirstOrDefaultAsync(cancellationToken);

            if (answer is not null)
            {
                messagesToDelete.Add(answer);
            }
        }

        db.Messages.RemoveRange(messagesToDelete.DistinctBy(message => message.Id));

        var staleSummaries = await db.Summaries
            .Where(summary =>
                summary.BranchId == branchId ||
                (summary.ProjectId == target.Branch.ProjectId && summary.Scope == SummaryScope.Project))
            .ToListAsync(cancellationToken);
        db.Summaries.RemoveRange(staleSummaries);

        target.Branch.UpdatedAt = DateTimeOffset.UtcNow;
        target.Branch.Project.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task<ContextSummary> CreateSummaryAsync(Guid branchId, SummaryScope scope, CancellationToken cancellationToken)
    {
        var branch = await db.Branches
            .Include(item => item.Project)
            .FirstOrDefaultAsync(item => item.Id == branchId, cancellationToken);

        if (branch?.Project is null)
        {
            throw new InvalidOperationException("Branch not found.");
        }

        var sourceMessages = scope == SummaryScope.Project
            ? await GetProjectMessagesForSummaryAsync(branch.ProjectId, cancellationToken)
            : await GetBranchMessagesForSummaryAsync(branchId, cancellationToken);

        if (sourceMessages.Count == 0)
        {
            throw new InvalidOperationException("There are no messages to summarize.");
        }

        var transcript = string.Join(
            "\n\n",
            sourceMessages.Select(message => $"{message.Role.ToUpperInvariant()}:\n{message.Content}"));

        var summaryText = await ollama.ChatAsync(
            [
                new OllamaMessage("system", "You summarize chat context for future LLM turns. Preserve decisions, facts, open tasks, and user preferences. Be concise."),
                new OllamaMessage("user", $"Summarize this {(scope == SummaryScope.Project ? "project" : "branch")} context:\n\n{transcript}")
            ],
            cancellationToken);

        var summary = new ContextSummary
        {
            ProjectId = branch.ProjectId,
            BranchId = scope == SummaryScope.Branch ? branchId : null,
            Scope = scope,
            Content = summaryText,
            Model = _ollamaOptions.Model,
            FromSequence = scope == SummaryScope.Branch ? sourceMessages.Min(message => message.Sequence) : null,
            ToSequence = scope == SummaryScope.Branch ? sourceMessages.Max(message => message.Sequence) : null
        };

        db.Summaries.Add(summary);
        branch.Project.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);

        return summary;
    }

    private async Task<IReadOnlyList<OllamaMessage>> BuildContextAsync(ChatBranch branch, CancellationToken cancellationToken)
    {
        var context = new List<OllamaMessage>
        {
            new("system", "You are x-gpt, an open-source web chat for local Ollama models. Answer clearly and keep project context in mind.")
        };

        var projectSummaries = branch.Project?.ContextMode == ContextMode.ProjectShared
            ? await db.Summaries
                .Where(summary => summary.ProjectId == branch.ProjectId && summary.Scope == SummaryScope.Project)
                .ToListAsync(cancellationToken)
            : [];
        var projectSummary = projectSummaries
            .OrderByDescending(summary => summary.CreatedAt)
            .FirstOrDefault();

        if (projectSummary is not null)
        {
            context.Add(new OllamaMessage("system", $"Project summary:\n{projectSummary.Content}"));
        }

        var branchSummaries = await db.Summaries
            .Where(summary => summary.BranchId == branch.Id && summary.Scope == SummaryScope.Branch)
            .ToListAsync(cancellationToken);
        var branchSummary = branchSummaries
            .OrderByDescending(summary => summary.CreatedAt)
            .FirstOrDefault();

        if (branchSummary is not null)
        {
            context.Add(new OllamaMessage("system", $"Branch summary:\n{branchSummary.Content}"));
        }

        var recentMessages = await GetConversationMessagesForContextAsync(branch, cancellationToken);

        context.AddRange(recentMessages.Select(message => new OllamaMessage(message.Role, message.Content)));
        return context;
    }

    private async Task<int> GetNextSequenceAsync(Guid branchId, CancellationToken cancellationToken)
    {
        var lastSequence = await db.Messages
            .Where(message => message.BranchId == branchId)
            .Select(message => (int?)message.Sequence)
            .MaxAsync(cancellationToken);

        return (lastSequence ?? 0) + 1;
    }

    private async Task<List<ChatMessage>> GetBranchMessagesForSummaryAsync(Guid branchId, CancellationToken cancellationToken)
    {
        return await db.Messages
            .Where(message => message.BranchId == branchId)
            .OrderByDescending(message => message.Sequence)
            .Take(SummarySourceMessageLimit)
            .OrderBy(message => message.Sequence)
            .ToListAsync(cancellationToken);
    }

    private async Task<List<ChatMessage>> GetProjectMessagesForSummaryAsync(Guid projectId, CancellationToken cancellationToken)
    {
        var messages = await db.Messages
            .Where(message => message.Branch != null && message.Branch.ProjectId == projectId)
            .ToListAsync(cancellationToken);

        return messages
            .OrderByDescending(message => message.CreatedAt)
            .Take(SummarySourceMessageLimit)
            .OrderBy(message => message.CreatedAt)
            .ToList();
    }

    private async Task<List<ChatMessage>> GetConversationMessagesForContextAsync(ChatBranch branch, CancellationToken cancellationToken)
    {
        var segments = new List<List<ChatMessage>>();
        var currentBranch = branch;
        int? upToSequence = null;
        var visitedBranchIds = new HashSet<Guid>();

        while (visitedBranchIds.Add(currentBranch.Id))
        {
            var messagesQuery = db.Messages
                .Where(message => message.BranchId == currentBranch.Id);

            if (upToSequence.HasValue)
            {
                messagesQuery = messagesQuery.Where(message => message.Sequence <= upToSequence.Value);
            }

            var segment = await messagesQuery
                .OrderByDescending(message => message.Sequence)
                .Take(RecentContextMessageLimit)
                .OrderBy(message => message.Sequence)
                .ToListAsync(cancellationToken);

            segments.Add(segment);

            if (!currentBranch.ParentBranchId.HasValue)
            {
                break;
            }

            upToSequence = null;
            if (currentBranch.ParentMessageId.HasValue)
            {
                upToSequence = await db.Messages
                    .Where(message => message.Id == currentBranch.ParentMessageId.Value)
                    .Select(message => (int?)message.Sequence)
                    .FirstOrDefaultAsync(cancellationToken);
            }

            var parentBranch = await db.Branches
                .FirstOrDefaultAsync(item => item.Id == currentBranch.ParentBranchId.Value, cancellationToken);

            if (parentBranch is null)
            {
                break;
            }

            currentBranch = parentBranch;
        }

        segments.Reverse();
        return segments
            .SelectMany(segment => segment)
            .TakeLast(RecentContextMessageLimit)
            .ToList();
    }

    private async Task TouchProjectAsync(Guid projectId, CancellationToken cancellationToken)
    {
        var project = await db.Projects.FindAsync([projectId], cancellationToken);
        if (project is not null)
        {
            project.UpdatedAt = DateTimeOffset.UtcNow;
        }
    }
}

public sealed record ChatTurnResult(ChatMessage UserMessage, ChatMessage AssistantMessage);

public sealed record ChatStreamChunk(string Type, string Text);
