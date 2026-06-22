#!/usr/bin/env python3
"""Generate publication-quality figures for the graph-native benchmark report.
All numbers are the log-confirmed benchmark results. Output: report/figs/*.pdf (vector)."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
import numpy as np
import os

OUT = os.path.join(os.path.dirname(__file__), "figs")
os.makedirs(OUT, exist_ok=True)

# palette
C = {"plain": "#9aa0a6", "graph-MCP": "#4285f4", "graph-native": "#0f9d58"}
ARMS = ["plain", "graph-MCP", "graph-native"]
plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False,
                     "figure.dpi": 150, "savefig.bbox": "tight", "font.family": "sans-serif"})

# ---------------------------------------------------------------- Fig 1: hardcore quality bars
tasks = ["H1\nrefactor", "H2\ndiagnose", "H3\ndead-code", "H4\ndata-flow", "H5\nsecurity", "H6\nmigration"]
q = {
    "plain":        [8.5, 5.4, 9.5, 9.2, 9.7, 7.8],
    "graph-MCP":    [9.0, 8.3, 7.5, 9.2, 10.0, 8.2],
    "graph-native": [9.0, 7.1, 9.5, 9.8, 9.8, 8.6],
}
x = np.arange(len(tasks)); w = 0.26
YLO = 4.5  # zoomed y-floor so the 5.4–10.0 spread is visible (labeled as a broken axis)
fig, ax = plt.subplots(figsize=(9.2, 4.6))
mat = np.array([q[a] for a in ARMS])  # arms x tasks
for i, a in enumerate(ARMS):
    bars = ax.bar(x + (i - 1) * w, q[a], w, label=a, color=C[a], zorder=3)
    for j, (b, v) in enumerate(zip(bars, q[a])):
        winner = abs(v - mat[:, j].max()) < 0.05
        if winner:  # gold ring + star on the per-task winner
            b.set_edgecolor("#c9a227"); b.set_linewidth(2.2)
        ax.text(b.get_x() + b.get_width() / 2, v + 0.12, f"{v:.1f}" + ("★" if winner else ""),
                ha="center", va="bottom", fontsize=8.5, fontweight="bold" if winner else "normal")
ax.set_xticks(x); ax.set_xticklabels(tasks, fontsize=10)
ax.set_ylim(YLO, 10.8); ax.set_yticks([5, 6, 7, 8, 9, 10])
ax.set_ylabel("Blind LLM-judge quality (0–10)")
ax.set_title("Hardcore tasks — quality by harness  (★ = per-task winner; y-axis starts at 4.5)",
             fontweight="bold", fontsize=12)
ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.13), ncol=3, frameon=False, fontsize=10)
ax.grid(axis="y", alpha=0.3, zorder=0)
# little broken-axis marker
ax.plot([0], [0], transform=ax.transAxes)
fig.savefig(os.path.join(OUT, "hardcore_quality.pdf")); plt.close(fig)

# ---------------------------------------------------------------- Fig 2: quality-per-dollar + mean
means = {"plain": 8.35, "graph-MCP": 8.70, "graph-native": 8.97}
qpd = {"plain": 6.7, "graph-MCP": 7.3, "graph-native": 8.2}
fig, axes = plt.subplots(1, 2, figsize=(9, 3.8))
# Each panel uses a ZOOMED y-axis (annotated) so the between-arm gaps are actually visible.
for ax, data, title, ylab, ylo, yhi, fmt in [
    (axes[0], means, "Mean quality (n=6)\n[y starts at 8.0]", "quality / 10", 8.0, 9.3, "{:.2f}"),
    (axes[1], qpd, "Quality per dollar\n[y starts at 6.0]", "quality points / $", 6.0, 8.7, "{:.1f}"),
]:
    bars = ax.bar(ARMS, [data[a] for a in ARMS], color=[C[a] for a in ARMS], width=0.62, zorder=3)
    base = data["plain"]
    for b, a in zip(bars, ARMS):
        delta = "" if a == "plain" else f"  (+{100*(data[a]-base)/base:.0f}%)"
        ax.text(b.get_x() + b.get_width() / 2, data[a] + (yhi - ylo) * 0.02, fmt.format(data[a]),
                ha="center", va="bottom", fontsize=10, fontweight="bold")
        if a == "graph-native":  # mark the winner
            b.set_edgecolor("#c9a227"); b.set_linewidth(2.2)
    ax.set_title(title, fontweight="bold", fontsize=11); ax.set_ylabel(ylab); ax.set_ylim(ylo, yhi)
    ax.set_xticks(range(3)); ax.set_xticklabels(ARMS, rotation=12); ax.grid(axis="y", alpha=0.3, zorder=0)
fig.suptitle("Graph-native: best average quality AND best cost-efficiency", fontweight="bold", y=1.04)
fig.savefig(os.path.join(OUT, "quality_per_dollar.pdf")); plt.close(fig)

# ---------------------------------------------------------------- Fig 3: winner heatmap
# Color = RANK WITHIN EACH TASK (1st/2nd/3rd) so the win-pattern is unmistakable; the real
# score is printed in each cell, and the per-task winner gets a gold box. Per-row coloring
# fixes the old "everything is the same green" problem (absolute scores cluster in 7-10).
from matplotlib.colors import ListedColormap
from matplotlib.patches import Rectangle
kinds = ["H1 refactor-plan", "H2 bug-diagnosis", "H3 dead-code", "H4 data-flow", "H5 security", "H6 migration"]
M = np.array([q["plain"], q["graph-MCP"], q["graph-native"]]).T  # tasks x arms
# rank per row: 0 = best (incl. ties), 1 = middle, 2 = worst
rankcol = np.zeros_like(M)
for i in range(M.shape[0]):
    order = (-M[i]).argsort()
    ranks = np.empty(3, int);
    # assign tie-aware rank buckets by value
    vals = M[i]
    for j in range(3):
        rankcol[i, j] = sum(1 for v in vals if v > vals[j] + 1e-9)  # 0=best,1,2
rank_cmap = ListedColormap(["#0f9d58", "#a8d5b5", "#f3c9c0"])  # best=green, mid=pale green, worst=pale red
fig, ax = plt.subplots(figsize=(7.4, 4.6))
im = ax.imshow(rankcol, cmap=rank_cmap, vmin=0, vmax=2, aspect="auto")
ax.set_xticks(range(3)); ax.set_xticklabels(ARMS, fontsize=11)
ax.set_yticks(range(len(kinds))); ax.set_yticklabels(kinds, fontsize=10)
ax.set_xticks(np.arange(-.5, 3, 1), minor=True); ax.set_yticks(np.arange(-.5, 6, 1), minor=True)
ax.grid(which="minor", color="white", linewidth=2.5); ax.tick_params(which="minor", length=0)
for i in range(len(kinds)):
    rowmax = M[i].max()
    for j in range(3):
        win = abs(M[i, j] - rowmax) < 0.05
        ax.text(j, i, f"{M[i,j]:.1f}", ha="center", va="center", fontsize=12,
                fontweight="bold" if win else "normal", color="#202124")
        if win:
            ax.add_patch(Rectangle((j - .5, i - .5), 1, 1, fill=False, edgecolor="#c9a227", linewidth=3, zorder=5))
ax.set_title("Per-task quality — green = best for that task, gold box = winner\n(cell number is the 0–10 judge score)",
             fontweight="bold", fontsize=11)
# legend for the rank colors
from matplotlib.patches import Patch
ax.legend(handles=[Patch(facecolor="#0f9d58", label="best on this task"),
                   Patch(facecolor="#a8d5b5", label="middle"),
                   Patch(facecolor="#f3c9c0", label="worst")],
          loc="upper center", bbox_to_anchor=(0.5, -0.10), ncol=3, frameon=False, fontsize=9)
fig.savefig(os.path.join(OUT, "heatmap.pdf")); plt.close(fig)

# ---------------------------------------------------------------- Fig 4: 3-harness retrieval oracle mean F1
ret = {"plain": 0.314, "graph-MCP": 0.702, "graph-native": 0.768}
fig, ax = plt.subplots(figsize=(5.2, 3.6))
bars = ax.bar(ARMS, [ret[a] for a in ARMS], color=[C[a] for a in ARMS], width=0.6)
for b, a in zip(bars, ARMS):
    ax.text(b.get_x() + b.get_width() / 2, ret[a] + 0.01, f"{ret[a]:.3f}", ha="center", va="bottom", fontweight="bold")
ax.set_ylim(0, 0.85); ax.set_ylabel("mean F1 @ top-15"); ax.set_xticklabels(ARMS, rotation=12)
ax.set_title("Retrieval oracle — mean F1 (8 tasks)", fontweight="bold"); ax.grid(axis="y", alpha=0.25)
fig.savefig(os.path.join(OUT, "retrieval_f1.pdf")); plt.close(fig)

# ---------------------------------------------------------------- Fig 5: cost per task (grouped)
cost = {
    "plain":        [1.268, 1.736, 1.079, 1.678, 1.024, 0.742],
    "graph-MCP":    [0.906, 1.479, 1.336, 1.462, 0.907, 1.055],
    "graph-native": [0.711, 1.838, 0.951, 1.337, 0.986, 0.737],
}
fig, ax = plt.subplots(figsize=(9, 3.6))
for i, a in enumerate(ARMS):
    ax.bar(x + (i - 1) * w, cost[a], w, label=a, color=C[a])
ax.set_xticks(x); ax.set_xticklabels(tasks); ax.set_ylabel("cost per task (USD)")
ax.set_title("Cost per task — graph-native cheapest on 4 of 6", fontweight="bold")
ax.legend(ncol=3, frameon=False, fontsize=9, loc="upper right"); ax.grid(axis="y", alpha=0.25)
fig.savefig(os.path.join(OUT, "cost.pdf")); plt.close(fig)

print("figures written:", sorted(os.listdir(OUT)))
