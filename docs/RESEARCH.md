# Foundry — Supporting Research

Evidence that the re-alignment tax is real and the memory wall is a structural problem, not a model capability problem.

---

## Studies

### Remote Labor Index (Scale AI + Center for AI Safety, 2025)
- **Claim:** Best frontier agent completed 2.5% of real Upwork projects at quality a paying client would accept — 97.5% failure rate on real work
- **Why it matters:** These are the same models that score near-expert on benchmarks. The gap is context, not capability. Benchmarks provide full context. Real jobs don't.
- **Link:** https://www.reddit.com/r/ArtificialInteligence/comments/1r40nmh/ai_fails_at_96_of_jobs_new_study/
- **Full study:** Scale AI Remote Labor Index

### SWECI / SWE-CI (Alibaba, 2025)
- **Claim:** 75% of frontier models break previously working features when asked to maintain a codebase over time (100 real codebases, avg 233 days, 71 consecutive updates)
- **Why it matters:** Writing code and maintaining code are different skills. AI is good at the former, bad at the latter. Almost every benchmark tests the former.
- **Key finding:** Agents whose early decisions compound into technical debt — and almost all of them do.

### Harvard Seniority Paper (Hoseni, Maum & Lickinger, 2025)
- **Claim:** Companies adopting generative AI saw junior employment drop ~8% relative to non-adopters within 18 months. Senior employment kept rising.
- **Why it matters:** The market is learning in real time that context is the scarce resource. Task execution is being absorbed. Contextual judgment is not.
- **Key finding:** Decline driven by slower hiring, not firing. Junior roles shrink when tasks are automated. Senior roles grow when context becomes more valuable.

### Instruction-Following Degradation (cited in Foundry vision)
- **Claim:** GPT-4o follows 10 simultaneous instructions just 15% of the time. Adding full conversation history drops accuracy 30% vs focused context windows.
- **Why it matters:** Stale rules don't fail loudly — they quietly degrade everything. More documentation is not always better documentation.
- **Source:** [needs citation — surface the original paper]

---

## Market Signals

### Gartner (February 2026)
- **Claim:** By 2027, half the companies that cut staff for AI will rehire workers to perform similar functions, often under different job titles
- **Supporting data:** Survey of 300+ customer service leaders found only 20% had actually reduced headcount because of AI

### Forrester (2026)
- **Claim:** 55% of employers say they regret AI-driven layoffs

### 11 Labs AI Insurance
- Agents are now being insured against catastrophic errors
- Signal that the industry is acknowledging agent failure modes are real and costly

---

## Incident Reports

### Alexi Gregorov — Database Wipe (2026)
- AI coding agent destroyed production database: 1.9M rows of student data, 24 hours to recover via emergency AWS support
- Agent made no technical errors. Every action was logically correct. It simply had no idea it was operating on production infrastructure because that knowledge existed only in the engineer's head.
- **Source:** Public post-mortem (link when available)
- **Key lesson:** The only thing that could have prevented this was either a human who understood the organizational context OR an evaluation that encoded that context into a guardrail.

---

## Adjacent Thinking

### "The Real Problem With AI Coding Isn't Capability. It's Alignment" (Aron Greenspan, Inixiative, March 2026)
- The Foundry thesis in article form — gradient descent on documentation, the three layers, the re-alignment tax
- https://inixiative.substack.com/p/the-real-problem-with-ai-coding-isnt

### Karpathy's Autoresearch
- Self-improving research agent that optimizes on a single metric
- Useful reference point: proves self-improvement is architecturally possible, but too narrow (one metric, no regression testing, no corpus)

---

## What the Research Collectively Shows

The benchmark vs. real-world gap is consistent across domains:
- **GDP-val** (full context provided) → near-expert performance
- **Remote Labor Index** (bring your own context) → 97.5% failure
- **SWECI** (maintain over time) → 75% regression rate

The pattern: AI is excellent at tasks when context is provided. AI fails at jobs that require you to bring your own context. The re-alignment tax is the cost of bridging that gap manually — session by session, correction by correction, convention re-explained by convention re-explained.

Foundry is the infrastructure for closing that gap systematically.

---

*Add to this file as new research surfaces. Prioritize studies with specific numbers, real-world incident reports, and market data that can replace fabricated statistics in marketing materials.*
