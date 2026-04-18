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

// ---------------------------------------------------------------------------
// Provider definitions (mirrors config.ts)
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    id: "claude-code",
    label: "Claude Code (recommended)",
    desc: "CLI subscription — no API key needed, works out of the box",
    envKey: "",
    models: [
      { id: "sonnet", label: "Sonnet 4.6", tier: "standard" },
      { id: "opus", label: "Opus 4.6", tier: "powerful" },
      { id: "haiku", label: "Haiku 4.5", tier: "fast" },
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
      { id: "claude-opus-4-7", label: "Opus 4.7", tier: "powerful" },
      { id: "claude-opus-4-6", label: "Opus 4.6", tier: "powerful" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: "standard" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "fast" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    desc: "GPT models — alternative provider",
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4", tier: "powerful" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", tier: "standard" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", tier: "powerful" },
      { id: "o4-mini", label: "o4-mini", tier: "fast" },
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

function ProvidersStep({ enabled, onToggle, onNext, onBack }) {
  return html`
    <div class="wizard-step">
      <h2 class="wizard-heading">Enable Providers</h2>
      <p class="wizard-desc">
        Which LLM providers will you use? Enable all that apply —
        different agents can use different providers.
      </p>

      <div class="wizard-options">
        ${PROVIDERS.map(p => html`
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

function DefaultProviderStep({ enabled, selected, onSelect, onNext, onBack }) {
  const enabledProviders = PROVIDERS.filter(p => enabled.includes(p.id));

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

function ExecutorModelStep({ provider, selected, onSelect, onNext, onBack }) {
  const prov = PROVIDERS.find(p => p.id === provider);
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

function ClassifierModelStep({ enabledProviders, provider, selected, onSelect, onSelectProvider, onNext, onBack }) {
  const prov = PROVIDERS.find(p => p.id === provider);
  if (!prov) return null;

  const tierColors = { fast: "#4ade80", standard: "#6c9eff", powerful: "#c084fc" };
  const availableProviders = PROVIDERS.filter(p => enabledProviders.includes(p.id));

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

function DoneStep({ enabledProviders, provider, executorModel, classifierProvider, classifierModel, saving }) {
  const execProv = PROVIDERS.find(p => p.id === provider);
  const execMod = execProv?.models.find(m => m.id === executorModel);
  const classProv = PROVIDERS.find(p => p.id === classifierProvider);
  const classMod = classProv?.models.find(m => m.id === classifierModel);
  const enabledNames = enabledProviders
    .map(id => PROVIDERS.find(p => p.id === id)?.label)
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

export function Wizard() {
  const isOpen = wizardOpen.value;
  // 0=welcome, 1=enable providers, 2=default provider, 3=executor model, 4=classifier model, 5=done
  const [step, setStep] = useState(0);
  const [enabledProviders, setEnabledProviders] = useState(["claude-code", "gemini"]);
  const [defaultProvider, setDefaultProvider] = useState("claude-code");
  const [executorModel, setExecutorModel] = useState("sonnet");
  const [classifierProvider, setClassifierProvider] = useState("");
  const [classifierModel, setClassifierModel] = useState("");
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const toggleProvider = (id) => {
    setEnabledProviders(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const handleSelectDefault = (id) => {
    setDefaultProvider(id);
    const prov = PROVIDERS.find(p => p.id === id);
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
    // Default classifier to the fastest model on the same provider
    if (!classifierProvider) {
      setClassifierProvider(defaultProvider);
      const prov = PROVIDERS.find(p => p.id === defaultProvider);
      const fast = prov?.models.find(m => m.tier === "fast");
      setClassifierModel(fast?.id || prov?.models[0]?.id || "");
    }
    setStep(4);
  };

  const handleClassifierProviderChange = (id) => {
    setClassifierProvider(id);
    const prov = PROVIDERS.find(p => p.id === id);
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

      // Update defaults — executor model is the global default
      await fetch("/api/settings/defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: defaultProvider,
          model: executorModel,
          classifierProvider,
          classifierModel,
        }),
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
            enabled=${enabledProviders}
            onToggle=${toggleProvider}
            onNext=${handleProvidersNext}
            onBack=${() => setStep(0)}
          />
        ` : null}
        ${step === 2 ? html`
          <${DefaultProviderStep}
            enabled=${enabledProviders}
            selected=${defaultProvider}
            onSelect=${handleSelectDefault}
            onNext=${() => setStep(3)}
            onBack=${() => setStep(1)}
          />
        ` : null}
        ${step === 3 ? html`
          <${ExecutorModelStep}
            provider=${defaultProvider}
            selected=${executorModel}
            onSelect=${setExecutorModel}
            onNext=${handleExecutorNext}
            onBack=${() => enabledProviders.length === 1 ? setStep(1) : setStep(2)}
          />
        ` : null}
        ${step === 4 ? html`
          <${ClassifierModelStep}
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
