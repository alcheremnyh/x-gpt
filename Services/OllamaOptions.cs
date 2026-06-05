namespace x_gpt.Services;

public sealed class OllamaOptions
{
    public string BaseUrl { get; set; } = "http://host.docker.internal:11434";
    public string Model { get; set; } = "llama3.1";
}
