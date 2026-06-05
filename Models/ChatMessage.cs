namespace x_gpt.Models;

public sealed class ChatMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BranchId { get; set; }
    public ChatBranch? Branch { get; set; }
    public required string Role { get; set; }
    public required string Content { get; set; }
    public int Sequence { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
