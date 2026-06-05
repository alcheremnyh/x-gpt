namespace x_gpt.Models;

public sealed class ContextSummary
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ProjectId { get; set; }
    public ChatProject? Project { get; set; }
    public Guid? BranchId { get; set; }
    public ChatBranch? Branch { get; set; }
    public SummaryScope Scope { get; set; }
    public required string Content { get; set; }
    public required string Model { get; set; }
    public int? FromSequence { get; set; }
    public int? ToSequence { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
