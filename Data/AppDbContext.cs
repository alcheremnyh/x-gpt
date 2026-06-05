using Microsoft.EntityFrameworkCore;
using x_gpt.Models;

namespace x_gpt.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<ChatProject> Projects => Set<ChatProject>();
    public DbSet<ChatBranch> Branches => Set<ChatBranch>();
    public DbSet<ChatMessage> Messages => Set<ChatMessage>();
    public DbSet<ContextSummary> Summaries => Set<ContextSummary>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<ChatProject>(entity =>
        {
            entity.Property(project => project.Name).HasMaxLength(200);
            entity.HasMany(project => project.Branches)
                .WithOne(branch => branch.Project)
                .HasForeignKey(branch => branch.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ChatBranch>(entity =>
        {
            entity.Property(branch => branch.Name).HasMaxLength(200);
            entity.HasIndex(branch => branch.ProjectId);
            entity.HasOne(branch => branch.ParentBranch)
                .WithMany()
                .HasForeignKey(branch => branch.ParentBranchId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasOne(branch => branch.ParentMessage)
                .WithMany()
                .HasForeignKey(branch => branch.ParentMessageId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<ChatMessage>(entity =>
        {
            entity.Property(message => message.Role).HasMaxLength(32);
            entity.HasIndex(message => new { message.BranchId, message.Sequence }).IsUnique();
        });

        modelBuilder.Entity<ContextSummary>(entity =>
        {
            entity.HasIndex(summary => new { summary.ProjectId, summary.Scope, summary.CreatedAt });
            entity.HasIndex(summary => new { summary.BranchId, summary.CreatedAt });
            entity.HasOne(summary => summary.Project)
                .WithMany(project => project.Summaries)
                .HasForeignKey(summary => summary.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(summary => summary.Branch)
                .WithMany(branch => branch.Summaries)
                .HasForeignKey(summary => summary.BranchId)
                .OnDelete(DeleteBehavior.Cascade);
        });
    }
}
