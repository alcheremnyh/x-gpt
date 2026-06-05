namespace x_gpt.Models;

public sealed class ChatBranch
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ProjectId { get; set; }
    public ChatProject? Project { get; set; }
    public required string Name { get; set; }
    public Guid? ParentBranchId { get; set; }
    public ChatBranch? ParentBranch { get; set; }
    public Guid? ParentMessageId { get; set; }
    public ChatMessage? ParentMessage { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    public ICollection<ChatMessage> Messages { get; set; } = new List<ChatMessage>();
    public ICollection<ContextSummary> Summaries { get; set; } = new List<ContextSummary>();
}
