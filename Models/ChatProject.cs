namespace x_gpt.Models;

public sealed class ChatProject
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Name { get; set; }
    public ContextMode ContextMode { get; set; } = ContextMode.BranchOnly;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    public ICollection<ChatBranch> Branches { get; set; } = new List<ChatBranch>();
    public ICollection<ContextSummary> Summaries { get; set; } = new List<ContextSummary>();
}
