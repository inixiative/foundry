/**
 * Setup Wizard — first-run configuration flow.
 * Shows when setupComplete is false/undefined in the config.
 * Steps: Welcome → Providers → Default Provider → Executor Model → Classifier Model → Done.
 */

import { html, useState, useEffect } from "./lib.js";
import { signal } from "./lib.js";
import { showToast } from "./store.js";

export const wizardOpen = signal(false);

// Check if setup is needed when settings load
export function checkSetupNeeded(config) {
  if (config && !config.setupComplete) {
    wizardOpen.value = true;
  }
}

const FALLBACK_PROVIDERS = [
  {
    id: "claude-code",
    label: "Claude Code (recommended)",
    desc: "CLI subscription — no API key needed, works out of the box",
    envKey: "",
    models: [
      { id: "fable", label: "Fable 5.1", tier: "powerful" },
      { id: "opus", label: "Opus 5", tier: "powerful" },
      { id: "sonnet", label: "Sonnet 5", tier: "standard" },
      { id: "haiku", label: "Haiku 4.5", tier: "fast" },
    ],
  },
  {
    id: "codex",
    label: "Codex CLI (recommended)",
    desc: "Native Codex harness — use Astra through your authenticated Codex session",
    envKey: "",
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", tier: "powerful" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "powerful" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "standard" },
      { id: "gpt-6-luna", label: "GPT-6 Luna", tier: "fast" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini (recommended)",
    desc: "Fast, affordable API access — best for high-volume agent work",
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", tier: "fast" },
      { id: "gemini-3.1-flash", label: "Gemini 3.1 Flash", tier: "standard" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", tier: "powerful" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    desc: "Direct API — for programmatic access without Claude Code CLI",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", tier: "powerful" },
      { id: "claude-opus-5", label: "Claude Opus 5", tier: "powerful" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", tier: "standard" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "fast" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    desc: "GPT models — alternative provider",
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", tier: "powerful" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "powerful" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "standard" },
      { id: "gpt-6-luna", label: "GPT-6 Luna", tier: "fast" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------

function WelcomeStep({ onNext }) {
  return html`
    <div class="wizard-step">
      <div class="wizard-logo"><span class="logo-bracket">${"<"}</span><span class="logo-mark">iXi</span><span class="logo-bracket">${">"}</span></div>
      <h2 class="wizard-heading">Welcome to Foundry</h2>
      <p class="wizard-desc">
        Foundry is an agent orchestration framework with context layers,
        signal buses, and tool-use loops.
      </p>
      <p class="wizard-desc">
        Let's configure your LLM provider and model to get started.
        You can change everything later in Settings.
      </p>
      <div class="wizard-actions">
        <button class="wizard-btn primary" onClick=${onNext}>Get Started</button>
      </div>
    </div>
  `;
}

function ProvidersStep({ providers, enabled, onToggle, onNext, onBack }) {
  return html`
    <div class="wizard-step">
      <h2 class="wizard-heading">Enable Providers</h2>
      <p class="wizard-desc">
        Which LLM providers will you use? Enable all that apply —
        different agents can use different providers.
      </p>
      <p class="wizard-desc dim">
        Foundry is subscription-only by default: the Claude Code worker and Codex
        (GPT-6 Luna) decisions use your existing logins. Choosing a provider that
        needs an API key opts this install in to API tokens.
      </p>

      <div class="wizard-options">
        ${providers.map(p => html`
          <button
            key=${p.id}
            class="wizard-option ${enabled.includes(p.id) ? "selected" : ""}"
            onClick=${() => onToggle(p.id)}
          >
            <span class="wizard-option-check">${enabled.includes(p.id) ? "✓" : " "}</span>
            <span class="wizard-option-label">${p.label}</span>
            <span class="wizard-option-desc">${p.desc}</span>
            ${p.envKey ? html`
              <span class="wizard-option-env">${p.envKey}</span>
            ` : null}
          </button>
        `)}
      </div>

      <div class="wizard-actions">
        <button class="wizard-btn" onClick=${onBack}>Back</button>
        <button class="wizard-btn primary" onClick=${onNext} disabled=${enabled.length === 0}>Next</button>
      </div>
    </div>
  `;
}

function DefaultProviderStep({ providers, enabled, selected, onSelect, onNext, onBack }) {
  const enabledProviders = providers.filter(p => enabled.includes(p.id));

  // Skip this step if only one provider enabled
  if (enabledProviders.length === 1 && !selected) {
    onSelect(enabledProviders[0].id);
  }

  return html`
    <div class="wizard-step">
      <h2 class="wizard-heading">Default Provider</h2>
      <p class="wizard-desc">
        Which provider should be the default? Agents will use this unless overridden.
      </p>

      <div class="wizard-options">
        ${enabledProviders.map(p => html`
          <button
            key=${p.id}
            class="wizard-option ${selected === p.id ? "selected" : ""}"
            onClick=${() => onSelect(p.id)}
          >
            <span class="wizard-option-label">${p.label}</span>
            <span class="wizard-option-desc">${p.desc}</span>
          </button>
        `)}
      </div>

      <div class="wizard-actions">
        <button class="wizard-btn" onClick=${onBack}>Back</button>
        <button class="wizard-btn primary" onClick=${onNext} disabled=${!selected}>Next</button>
      </div>
    </div>
  `;
}

function ExecutorModelStep({ providers, provider, selected, onSelect, onNext, onBack }) {
  const prov = providers.find(p => p.id === provider);
  if (!prov) return null;

  const tierColors = { fast: "#4ade80", standard: "#6c9eff", powerful: "#c084fc" };

  return html`
    <div class="wizard-step">
      <h2 class="wizard-heading">Executor Model</h2>
      <p class="wizard-desc">
        The executor handles tool use, code generation, and complex tasks.
        Pick a capable model — this is where quality matters most.
      </p>

      <div class="wizard-options">
        ${prov.models.map(m => html`
          <button
            key=${m.id}
            class="wizard-option ${selected === m.id ? "selected" : ""}"
            onClick=${() => onSelect(m.id)}
          >
            <span class="wizard-option-label">${m.label}</span>
            <span class="wizard-option-tier" style="color: ${tierColors[m.tier]}">${m.tier}</span>
            <span class="wizard-option-desc mono">${m.id}</span>
          </button>
        `)}
      </div>

      ${prov.envKey ? html`
        <div class="wizard-env-note">
          Make sure <code>${prov.envKey}</code> is set in your <code>.env.local</code> file.
        </div>
      ` : null}

      <div class="wizard-actions">
        <button class="wizard-btn" onClick=${onBack}>Back</button>
        <button class="wizard-btn primary" onClick=${onNext} disabled=${!selected}>Next</button>
      </div>
    </div>
  `;
}

function ClassifierModelStep({ providers, enabledProviders, provider, selected, onSelect, onSelectProvider, onNext, onBack }) {
  const prov = providers.find(p => p.id === provider);
  if (!prov) return null;

  const tierColors = { fast: "#4ade80", standard: "#6c9eff", powerful: "#c084fc" };
  const availableProviders = providers.filter(p => enabledProviders.includes(p.id));

  return html`
    <div class="wizard-step">
      <h2 class="wizard-heading">Classifier Model</h2>
      <p class="wizard-desc">
        The classifier and router run on every message to categorize and route requests.
        A fast, cheap model works best here — it runs often.
      </p>

      ${availableProviders.length > 1 ? html`
        <div class="wizard-provider-tabs">
          ${availableProviders.map(p => html`
            <button
              key=${p.id}
              class="wizard-tab ${provider === p.id ? "active" : ""}"
              onClick=${() => onSelectProvider(p.id)}
            >${p.label.split(" ")[0]}</button>
          `)}
        </div>
      ` : null}

      <div class="wizard-options">
        ${prov.models.map(m => html`
          <button
            key=${m.id}
            class="wizard-option ${selected === m.id ? "selected" : ""}"
            onClick=${() => onSelect(m.id)}
          >
            <span class="wizard-option-label">${m.label}</span>
            <span class="wizard-option-tier" style="color: ${tierColors[m.tier]}">${m.tier}</span>
            <span class="wizard-option-desc mono">${m.id}</span>
          </button>
        `)}
      </div>

      <p class="wizard-desc dim">
        Each agent can be individually configured with its own provider, model, and settings later.
      </p>

      <div class="wizard-actions">
        <button class="wizard-btn" onClick=${onBack}>Back</button>
        <button class="wizard-btn primary" onClick=${onNext} disabled=${!selected}>Finish Setup</button>
      </div>
    </div>
  `;
}

function DoneStep({ providers, enabledProviders, provider, executorModel, classifierProvider, classifierModel, saving }) {
  const execProv = providers.find(p => p.id === provider);
  const execMod = execProv?.models.find(m => m.id === executorModel);
  const classProv = providers.find(p => p.id === classifierProvider);
  const classMod = classProv?.models.find(m => m.id === classifierModel);
  const enabledNames = enabledProviders
    .map(id => providers.find(p => p.id === id)?.label)
    .filter(Boolean);

  return html`
    <div class="wizard-step">
      <div class="wizard-icon">${saving ? "..." : "\u2713"}</div>
      <h2 class="wizard-heading">${saving ? "Saving..." : "You're all set"}</h2>
      <div class="wizard-summary">
        <div class="wizard-summary-row">
          <span class="wizard-summary-label">Providers</span>
          <span class="wizard-summary-value">${enabledNames.join(", ")}</span>
        </div>
        <div class="wizard-summary-row">
          <span class="wizard-summary-label">Executor</span>
          <span class="wizard-summary-value">${execMod?.label || executorModel}</span>
        </div>
        <div class="wizard-summary-row">
          <span class="wizard-summary-label">Classifier</span>
          <span class="wizard-summary-value">${classMod?.label || classifierModel}${classifierProvider !== provider ? ` (${classProv?.label?.split(" ")[0]})` : ""}</span>
        </div>
      </div>
      ${!saving ? html`
        <p class="wizard-desc dim">
          Next: add a project to configure agents, layers, and sources.
          Open Settings (Ctrl+S) anytime to change providers.
        </p>
      ` : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Wizard component
// ---------------------------------------------------------------------------

async function patchSettings(section, body) {
  const res = await fetch(`/api/settings/${section}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Saving ${section} failed`);
}

export function Wizard() {
  const isOpen = wizardOpen.value;
  // 0=welcome, 1=enable providers, 2=default provider, 3=executor model, 4=classifier model, 5=done
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState(FALLBACK_PROVIDERS);
  const [enabledProviders, setEnabledProviders] = useState(["claude-code", "codex"]);
  const [defaultProvider, setDefaultProvider] = useState("claude-code");
  const [executorModel, setExecutorModel] = useState("fable");
  const [classifierProvider, setClassifierProvider] = useState("");
  const [classifierModel, setClassifierModel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((res) => res.ok ? res.json() : null)
      .then((body) => {
        if (!cancelled && Array.isArray(body?.providers) && body.providers.length > 0) {
          setProviders(body.providers);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!isOpen) return null;

  const toggleProvider = (id) => {
    setEnabledProviders(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const handleSelectDefault = (id) => {
    setDefaultProvider(id);
    const prov = providers.find(p => p.id === id);
    if (prov) setExecutorModel(prov.models[0].id);
  };

  // If only one provider enabled, skip the default-picker step
  const handleProvidersNext = () => {
    if (enabledProviders.length === 1) {
      handleSelectDefault(enabledProviders[0]);
      setStep(3); // skip to executor model
    } else {
      setStep(2);
    }
  };

  const handleExecutorNext = () => {
    // Subscription default: Codex Luna decisions beside a Claude Code worker.
    // Otherwise default the classifier to the fastest model on the same provider.
    if (!classifierProvider) {
      const subscription = defaultProvider === "claude-code" && enabledProviders.includes("codex");
      const id = subscription ? "codex" : defaultProvider;
      setClassifierProvider(id);
      const prov = providers.find(p => p.id === id);
      const fast = subscription ? prov?.models.find(m => m.id === "gpt-6-luna") : prov?.models.find(m => m.tier === "fast");
      setClassifierModel(fast?.id || prov?.models[0]?.id || "");
    }
    setStep(4);
  };

  const handleClassifierProviderChange = (id) => {
    setClassifierProvider(id);
    const prov = providers.find(p => p.id === id);
    const fast = prov?.models.find(m => m.tier === "fast");
    setClassifierModel(fast?.id || prov?.models[0]?.id || "");
  };

  const handleFinish = async () => {
    setSaving(true);
    setStep(5);

    try {
      // Update provider enabled states
      const settingsRes = await fetch("/api/settings");
      const config = await settingsRes.json();

      const updatedProviders = {};
      for (const [id, prov] of Object.entries(config.providers)) {
        updatedProviders[id] = { ...prov, enabled: enabledProviders.includes(id) };
      }
      await fetch("/api/settings/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedProviders),
      });

      // A Claude Code worker with native decisions stays subscription-only; any other choice opts in to API tokens.
      const subscription = defaultProvider === "claude-code" && classifierProvider === "codex";
      await patchSettings("apiTokens", { enabled: !subscription });

      // Update defaults — executor model is the global default
      await patchSettings("defaults", {
        provider: defaultProvider,
        model: executorModel,
        classifierProvider: subscription ? "subscription-decisions" : classifierProvider,
        classifierModel,
      });

      // Mark setup complete
      await fetch("/api/setup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      setSaving(false);
      showToast("Setup complete — add a project to get started", "ok");

      // Close wizard after a brief pause
      setTimeout(() => { wizardOpen.value = false; }, 1500);
    } catch (err) {
      setSaving(false);
      showToast("Setup failed: " + err.message, "error");
    }
  };

  const totalSteps = 6;

  return html`
    <div class="overlay-backdrop wizard-backdrop">
      <div class="wizard-panel">
        <div class="wizard-progress">
          ${Array.from({ length: totalSteps }, (_, i) => html`
            <div key=${i} class="wizard-dot ${i <= step ? "active" : ""} ${i === step ? "current" : ""}"></div>
          `)}
        </div>

        ${step === 0 ? html`<${WelcomeStep} onNext=${() => setStep(1)} />` : null}
        ${step === 1 ? html`
          <${ProvidersStep}
            providers=${providers}
            enabled=${enabledProviders}
            onToggle=${toggleProvider}
            onNext=${handleProvidersNext}
            onBack=${() => setStep(0)}
          />
        ` : null}
        ${step === 2 ? html`
          <${DefaultProviderStep}
            providers=${providers}
            enabled=${enabledProviders}
            selected=${defaultProvider}
            onSelect=${handleSelectDefault}
            onNext=${() => setStep(3)}
            onBack=${() => setStep(1)}
          />
        ` : null}
        ${step === 3 ? html`
          <${ExecutorModelStep}
            providers=${providers}
            provider=${defaultProvider}
            selected=${executorModel}
            onSelect=${setExecutorModel}
            onNext=${handleExecutorNext}
            onBack=${() => enabledProviders.length === 1 ? setStep(1) : setStep(2)}
          />
        ` : null}
        ${step === 4 ? html`
          <${ClassifierModelStep}
            providers=${providers}
            enabledProviders=${enabledProviders}
            provider=${classifierProvider}
            selected=${classifierModel}
            onSelect=${setClassifierModel}
            onSelectProvider=${handleClassifierProviderChange}
            onNext=${handleFinish}
            onBack=${() => setStep(3)}
          />
        ` : null}
        ${step === 5 ? html`
          <${DoneStep}
            providers=${providers}
            enabledProviders=${enabledProviders}
            provider=${defaultProvider}
            executorModel=${executorModel}
            classifierProvider=${classifierProvider}
            classifierModel=${classifierModel}
            saving=${saving}
          />
        ` : null}
      </div>
    </div>
  `;
}
