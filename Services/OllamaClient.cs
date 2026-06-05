using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace x_gpt.Services;

public sealed class OllamaClient(HttpClient httpClient, IOptions<OllamaOptions> options)
{
    private readonly OllamaOptions _options = options.Value;

    public async Task<IReadOnlyList<OllamaModel>> ListModelsAsync(CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync("/api/tags", cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new OllamaException(
                response.StatusCode,
                _options.Model,
                string.IsNullOrWhiteSpace(error)
                    ? $"Ollama returned {(int)response.StatusCode} {response.ReasonPhrase}."
                    : error.Trim());
        }

        var payload = await response.Content.ReadFromJsonAsync<OllamaTagsResponse>(cancellationToken);
        return payload?.Models
            .OrderBy(model => model.Name)
            .ToList() ?? [];
    }

    public async Task<string> ChatAsync(IReadOnlyList<OllamaMessage> messages, CancellationToken cancellationToken)
    {
        return await ChatAsync(messages, null, cancellationToken);
    }

    public async Task<string> ChatAsync(IReadOnlyList<OllamaMessage> messages, string? model, CancellationToken cancellationToken)
    {
        var modelName = ResolveModel(model);
        using var response = await httpClient.PostAsJsonAsync(
            "/api/chat",
            new OllamaChatRequest(modelName, false, messages, null),
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new OllamaException(
                response.StatusCode,
                modelName,
                string.IsNullOrWhiteSpace(error)
                    ? $"Ollama returned {(int)response.StatusCode} {response.ReasonPhrase}."
                    : error.Trim());
        }

        var payload = await response.Content.ReadFromJsonAsync<OllamaChatResponse>(cancellationToken);
        return payload?.Message?.Content?.Trim() ?? string.Empty;
    }

    public async IAsyncEnumerable<OllamaStreamChunk> StreamChatAsync(
        IReadOnlyList<OllamaMessage> messages,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var chunk in StreamChatAsync(messages, null, cancellationToken))
        {
            yield return chunk;
        }
    }

    public async IAsyncEnumerable<OllamaStreamChunk> StreamChatAsync(
        IReadOnlyList<OllamaMessage> messages,
        string? model,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var modelName = ResolveModel(model);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/chat")
        {
            Content = JsonContent.Create(new OllamaChatRequest(modelName, true, messages, true))
        };

        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new OllamaException(
                response.StatusCode,
                modelName,
                string.IsNullOrWhiteSpace(error)
                    ? $"Ollama returned {(int)response.StatusCode} {response.ReasonPhrase}."
                    : error.Trim());
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var line = await reader.ReadLineAsync(cancellationToken);

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var error = JsonSerializer.Deserialize<OllamaStreamError>(line);
            if (!string.IsNullOrWhiteSpace(error?.Error))
            {
                throw new OllamaException(HttpStatusCode.OK, modelName, error.Error);
            }

            var payload = JsonSerializer.Deserialize<OllamaChatResponse>(line);
            var thinking = payload?.Thinking ?? payload?.Message?.Thinking;
            if (!string.IsNullOrEmpty(thinking))
            {
                yield return new OllamaStreamChunk("thinking", thinking);
            }

            var content = payload?.Message?.Content;
            if (!string.IsNullOrEmpty(content))
            {
                yield return new OllamaStreamChunk("content", content);
            }
        }
    }

    private string ResolveModel(string? model)
    {
        return string.IsNullOrWhiteSpace(model) ? _options.Model.Trim() : model.Trim();
    }
}

public sealed class OllamaException(HttpStatusCode statusCode, string model, string message) : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public string Model { get; } = model;
}

public sealed record OllamaMessage(string Role, string Content);

public sealed record OllamaStreamChunk(string Type, string Text);

public sealed record OllamaModel(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("model")] string Model);

internal sealed record OllamaTagsResponse(
    [property: JsonPropertyName("models")] IReadOnlyList<OllamaModel> Models);

internal sealed record OllamaChatRequest(
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("stream")] bool Stream,
    [property: JsonPropertyName("messages")] IReadOnlyList<OllamaMessage> Messages,
    [property: JsonPropertyName("think")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    bool? Think);

internal sealed record OllamaChatResponse(
    [property: JsonPropertyName("message")] OllamaResponseMessage? Message,
    [property: JsonPropertyName("thinking")] string? Thinking);

internal sealed record OllamaResponseMessage(
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("content")] string Content,
    [property: JsonPropertyName("thinking")] string? Thinking);

internal sealed record OllamaStreamError(
    [property: JsonPropertyName("error")] string? Error);
