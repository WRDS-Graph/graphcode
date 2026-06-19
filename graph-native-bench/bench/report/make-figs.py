#!/usr/bin/env python3
"""Generate all figures for the graph-native case-study report from real bench data."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np
import os

OUT = os.path.dirname(os.path.abspath(__file__))
plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 11,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.alpha": 0.25,
    "grid.linewidth": 0.6,
    "figure.dpi": 150,
})

# Palette
C_NATIVE = "#1b6e3c"   # green  - graph-native
C_MCP    = "#b8472a"   # red    - graph-MCP
C_PLAIN  = "#5a6472"   # gray   - plain
C_ORACLE = "#c9a227"   # gold   - oracle/raw
C_ACCENT = "#14467a"   # blue   - accent

# ----------------------------------------------------------------------------
# FIG 1 — Headline: F1 by arm across tasks, with 95% CI error bars
# ----------------------------------------------------------------------------
def fig_headline():
    tasks = ["I1\nResource\n(hub, 982 files)", "I8\nAbfsClient\n(clean tree)", "I10\nAbfsOutput\nStream", "MEAN"]
    native = [0.56, 0.82, 1.00, 0.79]; native_ci = [0.06, 0.00, 0.00, 0]
    mcp    = [0.07, 0.77, 0.67, 0.50]; mcp_ci    = [0.06, 0.00, 0.00, 0]
    plain  = [0.27, 0.74, 0.67, 0.56]; plain_ci  = [0.11, 0.29, 0.00, 0]
    oracle = [0.00, 0.36, 0.47, 0.28]

    x = np.arange(len(tasks)); w = 0.26
    fig, ax = plt.subplots(figsize=(9.2, 4.3))
    b1 = ax.bar(x - w, plain,  w, yerr=plain_ci,  capsize=3, color=C_PLAIN,  label="Plain (no graph)", edgecolor="white")
    b2 = ax.bar(x,      mcp,    w, yerr=mcp_ci,    capsize=3, color=C_MCP,    label="Graph-MCP (tool)", edgecolor="white")
    b3 = ax.bar(x + w,  native, w, yerr=native_ci, capsize=3, color=C_NATIVE, label="Graph-Native (harness)", edgecolor="white")
    # oracle floor as a marker
    for xi, ov in zip(x, oracle):
        ax.hlines(ov, xi - 1.5*w, xi + 1.5*w, color=C_ORACLE, ls="--", lw=1.6, zorder=5)
    ax.plot([], [], color=C_ORACLE, ls="--", lw=1.6, label="raw-graph oracle floor")

    for bars in (b1, b2, b3):
        for b in bars:
            h = b.get_height()
            ax.text(b.get_x() + b.get_width()/2, h + 0.015, f"{h:.2f}", ha="center", va="bottom",
                    fontsize=8.5, fontweight="bold")
    # annotate the collapse
    ax.annotate("MCP COLLAPSES\non the hub\n(ranks firehose in-context)",
                xy=(0.0, 0.07), xytext=(0.15, 0.40), fontsize=9, color=C_MCP, fontweight="bold",
                ha="left", arrowprops=dict(arrowstyle="->", color=C_MCP, lw=1.4))
    ax.set_xticks(x); ax.set_xticklabels(tasks, fontsize=9)
    ax.set_ylabel("Impact $F_1$  (top-20, higher = better)")
    ax.set_ylim(0, 1.12)
    ax.set_title("Same model · same graph · same prompt — only the harness differs",
                 fontsize=11.5, fontweight="bold", color=C_ACCENT)
    ax.legend(loc="upper left", fontsize=9, framealpha=0.95, ncol=2)
    # shade MEAN column
    ax.axvspan(3-0.45, 3+0.45, color=C_ACCENT, alpha=0.05)
    fig.tight_layout()
    fig.savefig(f"{OUT}/fig1_headline.pdf"); plt.close(fig)

# ----------------------------------------------------------------------------
# FIG 2 — The killer chart: how many of the 25 TRUE dependents each arm put in top-20 (I1)
# ----------------------------------------------------------------------------
def fig_hub_recall():
    arms = ["Graph-MCP\n(tool)", "Plain\n(no graph)", "Graph-Native\n(harness)"]
    found = [2, 6, 13]; total = 25
    colors = [C_MCP, C_PLAIN, C_NATIVE]
    fig, ax = plt.subplots(figsize=(7.6, 4.2))
    bars = ax.barh(arms, found, color=colors, edgecolor="white", height=0.6, zorder=3)
    ax.barh(arms, [total]*3, color="#e9e9ec", height=0.6, zorder=1)  # backdrop = 25
    ax.set_xlim(0, total)
    for b, f in zip(bars, found):
        ax.text(f + 0.4, b.get_y() + b.get_height()/2, f"{f} / 25  gold dependents",
                va="center", fontsize=10.5, fontweight="bold")
    ax.set_xlabel("True dependents surfaced in the top-20 answer  (out of 25)")
    ax.set_title("Case 1 · Resource hub: same 982-file graph, who ranks it into the top-20?",
                 fontsize=11.5, fontweight="bold", color=C_ACCENT)
    ax.text(0.5, -0.30, "The graph CONTAINS all 25. Graph-MCP must rank the firehose mid-reasoning and finds 2;\n"
            "the harness pre-ranks it in code and the agent keeps 13.  →  $F_1$ 0.07 vs 0.56 (8×).",
            transform=ax.transAxes, ha="center", fontsize=9.2, color="#333", style="italic")
    ax.grid(axis="y", alpha=0)
    fig.tight_layout()
    fig.savefig(f"{OUT}/fig2_hub_recall.pdf"); plt.close(fig)

# ----------------------------------------------------------------------------
# FIG 3 — Test-file trap (I10): every arm finds all 10 gold; precision decided by false positives
# ----------------------------------------------------------------------------
def fig_testtrap():
    arms = ["Plain", "Graph-MCP", "Graph-Native"]
    gold_found = [10, 10, 10]
    false_pos  = [10, 10, 0]
    test_fp    = [5, 7, 0]  # of the false positives, how many are test files
    fig, ax = plt.subplots(figsize=(8.0, 4.2))
    x = np.arange(len(arms)); w = 0.55
    ax.bar(x, gold_found, w, color=C_NATIVE, label="true dependents (gold)", edgecolor="white")
    ax.bar(x, false_pos, w, bottom=gold_found, color="#d9b8b0", label="false positives", edgecolor="white")
    # hatch the test-file portion of the false positives
    ax.bar(x, test_fp, w, bottom=[g+ (f-t) for g,f,t in zip(gold_found,false_pos,test_fp)],
           color="none", hatch="////", edgecolor=C_MCP, label="…of which are TEST files")
    for xi, (g, f) in enumerate(zip(gold_found, false_pos)):
        f1 = 1.0 if f == 0 else round(2*(g/(g+f))*1.0/((g/(g+f))+1.0), 2)
        ax.text(xi, g + f + 0.3, f"$F_1$ = {f1:.2f}", ha="center", fontweight="bold",
                color=(C_NATIVE if f == 0 else C_MCP), fontsize=11)
    ax.set_xticks(x); ax.set_xticklabels(arms, fontsize=10.5)
    ax.set_ylabel("Files committed to the top-20")
    ax.set_ylim(0, 23)
    ax.set_title("Case 2 · AbfsOutputStream: all 3 arms find every gold file — precision decides",
                 fontsize=11.3, fontweight="bold", color=C_ACCENT)
    ax.legend(loc="upper right", fontsize=8.8, framealpha=0.95)
    ax.text(0.5, -0.16, "Plain & MCP pad the list with test files (highest reference-density, never the answer) → precision 0.50.\n"
            "The harness ranker DEMOTES test files before the agent sees the draft → exactly 10 gold, precision 1.00.",
            transform=ax.transAxes, ha="center", fontsize=9.0, color="#333", style="italic")
    fig.tight_layout()
    fig.savefig(f"{OUT}/fig3_testtrap.pdf"); plt.close(fig)

# ----------------------------------------------------------------------------
# FIG 4 — Dual win: cost vs F1 (better AND cheaper)
# ----------------------------------------------------------------------------
def fig_cost_quality():
    # mean across the 3 tasks
    data = {
        "Graph-Native": (np.mean([0.273,0.281,0.306]), 0.79, C_NATIVE, "o"),
        "Graph-MCP":    (np.mean([0.384,0.384,0.389]), 0.50, C_MCP, "s"),
        "Plain":        (np.mean([0.526,0.567,0.709]), 0.56, C_PLAIN, "^"),
    }
    fig, ax = plt.subplots(figsize=(7.2, 4.4))
    for name, (cost, f1, c, m) in data.items():
        ax.scatter(cost, f1, s=380, color=c, marker=m, edgecolor="white", linewidth=1.5, zorder=3)
        ax.annotate(name, (cost, f1), textcoords="offset points", xytext=(12, 8),
                    fontsize=10.5, fontweight="bold", color=c)
    # "better & cheaper" arrow region
    ax.annotate("", xy=(0.30, 0.80), xytext=(0.55, 0.52),
                arrowprops=dict(arrowstyle="-|>", color=C_NATIVE, lw=2, alpha=0.5))
    ax.text(0.30, 0.84, "better &\ncheaper", color=C_NATIVE, fontweight="bold", fontsize=10, ha="center")
    ax.set_xlabel("Mean cost per task  (USD, ↓ better)")
    ax.set_ylabel("Mean $F_1$  (↑ better)")
    ax.set_xlim(0.2, 0.65); ax.set_ylim(0.4, 0.9)
    ax.invert_xaxis()  # cheaper to the right
    ax.set_title("The dual win: graph-native is the most accurate AND the cheapest arm",
                 fontsize=11, fontweight="bold", color=C_ACCENT)
    fig.tight_layout()
    fig.savefig(f"{OUT}/fig4_cost_quality.pdf"); plt.close(fig)

# ----------------------------------------------------------------------------
# FIG 5 — The algorithm: control-flow diagram (MCP vs Native) + the ranker formula
# ----------------------------------------------------------------------------
def fig_algorithm():
    fig, (axL, axR) = plt.subplots(1, 2, figsize=(11.0, 4.6), gridspec_kw={"width_ratios": [1.15, 1]})

    # ---- LEFT: two control-flow lanes ----
    axL.axis("off"); axL.set_xlim(0, 10); axL.set_ylim(0, 10)
    def box(ax, x, y, w, h, text, fc, tc="white", fs=8.5):
        b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.08,rounding_size=0.12",
                           fc=fc, ec="none"); ax.add_patch(b)
        ax.text(x+w/2, y+h/2, text, ha="center", va="center", color=tc, fontsize=fs, fontweight="bold")
    def arrow(ax, x1, y1, x2, y2, c="#444"):
        ax.add_patch(FancyArrowPatch((x1,y1),(x2,y2), arrowstyle="-|>", mutation_scale=13, lw=1.6, color=c))

    axL.text(5, 9.6, "Same graph, two control flows", ha="center", fontsize=11, fontweight="bold", color=C_ACCENT)
    # MCP lane
    axL.text(0.2, 8.7, "GRAPH-MCP  (tool)", fontsize=9.5, fontweight="bold", color=C_MCP)
    box(axL, 0.2, 7.4, 2.0, 0.9, "agent\nreasons", C_MCP)
    box(axL, 2.7, 7.4, 2.2, 0.9, "decides to\ncall impact", C_MCP)
    box(axL, 5.4, 7.4, 2.1, 0.9, "982-file\nFIREHOSE", "#999")
    box(axL, 8.0, 7.4, 1.8, 0.9, "rank in\ncontext ✗", C_MCP)
    arrow(axL, 2.2, 7.85, 2.7, 7.85); arrow(axL, 4.9, 7.85, 5.4, 7.85); arrow(axL, 7.5, 7.85, 8.0, 7.85)
    axL.text(5, 6.7, "ranking happens INSIDE the model's context → under-ranks", ha="center",
             fontsize=8.2, color=C_MCP, style="italic")

    # Native lane
    axL.text(0.2, 5.4, "GRAPH-NATIVE  (harness)", fontsize=9.5, fontweight="bold", color=C_NATIVE)
    box(axL, 0.2, 3.0, 2.1, 1.5, "HARNESS\n(before\nturn 0)", C_NATIVE)
    box(axL, 2.7, 4.1, 2.2, 0.8, "impact +\ncallers", C_NATIVE)
    box(axL, 2.7, 3.05, 2.2, 0.8, "RANK in code\n(test-free)", C_NATIVE)
    box(axL, 5.4, 3.55, 2.1, 0.9, "clean\nDRAFT", "#3a9")
    box(axL, 8.0, 3.55, 1.8, 0.9, "agent\nrefines ✓", C_NATIVE)
    arrow(axL, 2.3, 3.9, 2.7, 4.4); arrow(axL, 2.3, 3.8, 2.7, 3.4)
    arrow(axL, 4.9, 4.0, 5.4, 4.0); arrow(axL, 7.5, 4.0, 8.0, 4.0)
    axL.text(5, 2.3, "ranking happens IN CODE before the agent thinks → keeps the right few",
             ha="center", fontsize=8.2, color=C_NATIVE, style="italic")
    axL.text(5, 1.2, "↑ the ONLY difference between the arms ↑", ha="center", fontsize=9.5,
             fontweight="bold", color=C_ACCENT)

    # ---- RIGHT: the ranker scoring formula as a labeled stack ----
    axR.axis("off"); axR.set_xlim(0, 10); axR.set_ylim(0, 10)
    axR.text(5, 9.6, "The ranker (the algorithm)", ha="center", fontsize=11, fontweight="bold", color=C_ACCENT)
    axR.text(5, 8.8, "score(file) =", ha="center", fontsize=12, fontweight="bold")
    rows = [
        ("reference density", "how many times it uses the symbol", "#2c7fb8", "+refs"),
        ("direct-caller bonus", "1-hop caller (additive, not a tier)", "#41b6c4", "+8"),
        ("name-match", "basename⊃anchor → subtype/impl", "#7fcdbb", "+10"),
        ("package locality", "same package tiebreak", "#c7e9b4", "+4"),
        ("TEST-FILE penalty", "Test*/ITest*/ /test/  → buried", C_MCP, "−10⁵"),
    ]
    y = 7.8
    for name, desc, c, val in rows:
        b = FancyBboxPatch((0.6, y-0.62), 7.2, 0.92, boxstyle="round,pad=0.04,rounding_size=0.08",
                           fc=c, ec="none", alpha=0.9 if val!="−10⁵" else 1.0)
        axR.add_patch(b)
        tc = "white" if c in (C_MCP, "#2c7fb8") else "#1a1a1a"
        axR.text(0.95, y-0.16, name, fontsize=9.5, fontweight="bold", color=tc, va="center")
        axR.text(0.95, y-0.50, desc, fontsize=7.3, color=tc, va="center", style="italic")
        axR.text(8.45, y-0.16, val, fontsize=11, fontweight="bold", color=c if val=="−10⁵" else "#222", va="center", ha="center")
        y -= 1.18
    axR.text(5, 0.75, "sort ↓ score, cap top-20.   Held-out $F_1$:  raw 0.17 → ranked 0.52",
             ha="center", fontsize=9.2, fontweight="bold", color=C_NATIVE)
    fig.tight_layout()
    fig.savefig(f"{OUT}/fig5_algorithm.pdf"); plt.close(fig)

# ----------------------------------------------------------------------------
# FIG 6 — The thinking process: the iteration journey (what we tried, what the data forced)
# ----------------------------------------------------------------------------
def fig_journey():
    fig, ax = plt.subplots(figsize=(11.0, 4.8))
    # stages along x; y = held-out F1 (or the honest scored value)
    stages = [
        ("v0\nregister tools\n+ prompt", 0.10, "lost to MCP on\nefficiency", C_PLAIN, False),
        ("iter-3\n'paste the\nfirehose'", 0.80, "✗ SCORING ARTIFACT\n(agent copied a\npasted list)", C_MCP, True),
        ("hardened\nscoring\n(F1, cap-20)", 0.36, "artifact dies:\nparity with grep", C_ACCENT, False),
        ("ranker v1\ndensity+pkg\n+caller", 0.386, "real, held-out\nbeats 7/9", "#3a9", False),
        ("ranker v2\n+test-demote\n+name-match", 0.519, "beats 9/9\n(production)", C_NATIVE, False),
        ("v3 +co-change\n(git history)", 0.519, "tested → NEUTRAL\nkept honest, not\nshipped as win", C_ORACLE, False),
    ]
    xs = np.arange(len(stages))
    ys = [s[1] for s in stages]
    # line
    ax.plot(xs, ys, "-", color="#bbb", lw=1.5, zorder=1)
    for i, (label, y, note, c, artifact) in enumerate(stages):
        ax.scatter(i, y, s=300, color=c, edgecolor="white", linewidth=1.8, zorder=3,
                   marker=("X" if artifact else "o"))
        ax.text(i, y + (0.07 if not artifact else 0.0), f"{y:.2f}" if y not in (0.10,) else "~0.1",
                ha="center", va="bottom", fontsize=9, fontweight="bold")
        va = "top" if i in (1,) else "bottom"
        ax.annotate(note, (i, y), textcoords="offset points",
                    xytext=(0, -28 if i in (1,2) else 26), ha="center", fontsize=7.8,
                    color=c, fontweight="bold")
        ax.text(i, -0.13, label, ha="center", va="top", fontsize=8.3, transform=ax.get_xaxis_transform())
    # strike-through the artifact
    ax.annotate("retracted", (1, 0.80), textcoords="offset points", xytext=(40, 6),
                fontsize=9, color=C_MCP, fontweight="bold", rotation=0)
    ax.axhline(0.169, color=C_ORACLE, ls="--", lw=1.3)
    ax.text(5.4, 0.185, "raw-graph oracle floor (0.17)", color=C_ORACLE, fontsize=8, ha="right")
    ax.set_ylim(-0.02, 0.95); ax.set_xlim(-0.4, 5.6)
    ax.set_xticks([])
    ax.set_ylabel("Honest held-out $F_1$  (what the metric actually credits)")
    ax.set_title("The thinking process: every step was forced by the data, including killing our own wins",
                 fontsize=11.3, fontweight="bold", color=C_ACCENT)
    ax.grid(axis="x", alpha=0)
    fig.tight_layout()
    fig.savefig(f"{OUT}/fig6_journey.pdf"); plt.close(fig)

for f in (fig_headline, fig_hub_recall, fig_testtrap, fig_cost_quality, fig_algorithm, fig_journey):
    f(); print("ok", f.__name__)
print("ALL FIGURES WRITTEN to", OUT)
