namespace x_gpt.Services;

public sealed class StorageOptions
{
    public string DataDirectory { get; set; } = "/app/data";
    public string DatabaseFileName { get; set; } = "xgpt.db";
}
