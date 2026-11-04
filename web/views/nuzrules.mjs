// The Solo Nuzlocke rule editor – one set of rules, texts and options for both places that edit them:
// the new-run wizard (variant 'wizard': compact, the toggles only for "Custom") and the board's Rules tab
// (variant 'board': grouped panels, every toggle always visible).
import { html, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { RULE_PRESETS, presetOf } from '../lib/run.mjs';

const presets = () => [
  ['classic', t('nzr.classic', 'Classic'), t('nzr.classicText', 'The two core rules – only the first Pokémon of each area, fainted means dead – plus the dupes clause (an evolution line you already caught doesn’t count, keep looking) and the shiny clause (a shiny is a free catch). A blackout ends the run.')],
  ['hardcore', t('nzr.hardcore', 'Hardcore'), t('nzr.hardcoreText', 'Classic plus level caps (never above the strongest Pokémon of the next boss), no items from the bag in battle and the “Set” battle style.')],
  ['custom', t('nzr.custom', 'Custom'), t('nzr.customText', 'Switch every rule on or off yourself.')],
];

const areaOptions = () => [['area', t('nzr.optArea', 'Count as the area')], ['free', t('nzr.optFree', 'Free extra')], ['banned', t('nzr.optBanned', 'Not allowed')]];

/**
 * Every rule once: `check` = on/off, `choice` = one of `options`. `section` groups them on the board; `honour`
 * marks rules the app can't see (it only reminds you).
 */
const ruleDefs = () => [
  { key: 'autoDeath', kind: 'check', section: 'core', label: t('nzr.autoDeath', 'Fainted means dead'), hint: t('nzr.autoDeathHint', 'Marked dead by the app as soon as its HP hits 0.') },
  { key: 'blackout', kind: 'choice', section: 'core', label: t('nzr.blackout', 'Blackout'),
    hint: t('nzr.blackoutHint', 'Your whole team is down. “Nothing left”: the run goes on with the box until no caught Pokémon is alive.'),
    options: [['party', t('nzr.blackoutParty', 'Ends the run')], ['box', t('nzr.blackoutBox', 'When nothing is left')], ['off', t('rules.off', 'Off')]] },
  { key: 'deathless', kind: 'check', section: 'core', label: t('nzr.deathless', 'Deathless'), hint: t('nzr.deathlessHint', 'The first death ends the run.') },
  { key: 'dupes', kind: 'choice', section: 'clauses', label: t('rules.dupes', 'Dupes clause'), hint: t('nz.dupesHint', 'Already caught it? Keep looking – dead ones count too.'),
    options: [['off', t('rules.off', 'Off')], ['species', t('nzr.dupesSpecies', 'Same species')], ['line', t('nzr.dupesLine', 'Whole evolution line')]] },
  { key: 'shinyClause', kind: 'check', section: 'clauses', label: t('nzr.shiny', 'Shiny clause'), hint: t('nz.shinyHint', 'A shiny may always be caught, even on a used area – a bonus.') },
  { key: 'gifts', kind: 'choice', section: 'clauses', label: t('nzr.gifts', 'Gifts & eggs'), hint: t('nz.giftsHint', 'Starter aside: eggs, trades, fossils and gift Pokémon.'), options: areaOptions() },
  { key: 'statics', kind: 'choice', section: 'clauses', label: t('nzr.statics', 'Static encounters'), hint: t('nz.staticsHint', 'Legendaries and fixed encounters like Sudowoodo or Snorlax.'), options: areaOptions() },
  { key: 'typeClause', kind: 'choice', section: 'clauses', label: t('rules.type', 'Type rule'), hint: t('rules.typeHint', 'Primary types may not repeat in the team.'),
    options: [['off', t('rules.off', 'Off')], ['party', t('nzr.typeParty', 'In the team')]] },
  { key: 'nicknames', kind: 'check', section: 'clauses', label: t('nzr.nicknames', 'Nickname every catch'), hint: t('nz.nicknamesHint', 'A gentle reminder while a team member still has its species name.') },
  { key: 'levelCaps', kind: 'choice', section: 'hardcore', label: t('nzr.caps', 'Level caps'), hint: t('nz.capsHint', 'The next boss’s ace level. Strict: going over is a rule break, not a hint.'),
    options: [[false, t('rules.off', 'Off')], ['warn', t('nzr.capsWarn', 'Warn')], ['strict', t('nzr.capsStrict', 'Strict')]] },
  { key: 'noBattleItems', kind: 'check', section: 'hardcore', honour: true, label: t('nzr.noItems', 'No items in battle'), hint: t('nz.noItemsHint', 'Poké Balls and held items are fine.') },
  { key: 'setMode', kind: 'check', section: 'hardcore', honour: true, label: t('nzr.setMode', '“Set” battle style'), hint: t('nz.setModeHint', 'Battle style “Set” in the game options: no free switch after a knockout.') },
];

// stored values that mean the same as an option ('levelCaps: true' is the old name of 'strict')
const shown = (key, v) => (key === 'levelCaps' ? (v === true ? 'strict' : v || false) : key === 'typeClause' ? (v === 'off' ? 'off' : 'party') : v);

const Honour = () => html`<span class="honour" title=${t('nz.honourHint', 'The app can’t check this – it only reminds you. Keep it yourself.')}>${t('nz.honour', 'honour rule')}</span>`;

/** A segmented one-of-n control (also used by the SoulLink rules on the board). */
export function Choice({ value, options, onChange, label }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>${options.map(([v, l]) => html`<button type="button" role="radio" aria-checked=${value === v} class=${value === v ? 'on' : ''} onClick=${() => onChange(v)}>${l}</button>`)}</div>`;
}

function RuleCheck({ checked, onChange, label, hint, honour, disabled }) {
  return html`<label class="check"><input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />
    <span>${label}${honour && html` <${Honour} />`}${hint && html`<span class="hint">${hint}</span>`}</span></label>`;
}

/** One rule with its title, hint and control (board layout). */
function RuleRow({ title, hint, honour, children }) {
  return html`<div class="rule-row">
    <div class="rr-text"><h3>${title}${honour && html` <${Honour} />`}</h3>${hint && html`<p class="small muted">${hint}</p>`}</div>
    <div class="rr-ctl">${children}</div>
  </div>`;
}

/** Pokémon Center visits per badge: none (0 = no limit) or 1–9. */
function CenterLimit({ value, onChange }) {
  const n = value > 0 ? value : 0;
  return html`<div class="row" style="gap:8px">
    <${Choice} label=${t('nz.centers', 'Pokémon Center limit')} value=${n > 0 ? 'on' : 'off'} onChange=${(v) => onChange(v === 'on' ? Math.max(1, n || 2) : 0)}
      options=${[['off', t('nz.noLimit', 'No limit')], ['on', t('nz.perBadge', 'Per badge')]]} />
    ${n > 0 && html`<input type="number" class="num-in" min="1" max="9" value=${n} aria-label=${t('nz.centersN', 'Visits per badge')}
      onChange=${(e) => onChange(Math.max(1, Math.min(9, Math.round(Number(e.target.value) || 1))))} />`}
  </div>`;
}

/**
 * value: the rules; onChange(patch). A preset only sets the toggles; "Custom" is stored as `preset: 'custom'`
 * so it stays chosen even while the toggles happen to match a preset.
 */
export function NuzlockeRules({ value, onChange, variant = 'board' }) {
  const wizard = variant === 'wizard';
  const chosen = value.preset === 'custom' ? 'custom' : presetOf(value);
  // the wizard shows the toggles only once "Custom" is picked
  const [open, setOpen] = useState(chosen === 'custom');
  const current = wizard && open ? 'custom' : chosen;
  const pick = (id) => {
    if (wizard) setOpen(id === 'custom');
    onChange(id === 'custom' ? { preset: 'custom' } : { ...RULE_PRESETS[id], preset: null });
  };
  // editing a toggle on the board: no longer a preset (presetOf tells whether it still happens to match one);
  // in the wizard you are in "Custom" already
  const edit = (patch) => onChange({ ...patch, preset: wizard ? 'custom' : null });
  const defs = ruleDefs();
  const control = (d) => (d.kind === 'check'
    ? html`<${RuleCheck} checked=${value[d.key]} onChange=${(v) => edit({ [d.key]: v })} label=${d.label} hint=${d.hint} honour=${d.honour} />`
    : html`<${Choice} label=${d.label} value=${shown(d.key, value[d.key])} onChange=${(v) => edit({ [d.key]: v })} options=${d.options} />`);
  const center = html`<${CenterLimit} value=${value.centerLimit} onChange=${(n) => edit({ centerLimit: n })} />`;

  if (wizard) {
    return html`<div class="stack">
      <div class="preset-list" role="radiogroup" aria-label=${t('nzr.presets', 'Rule set')}>
        ${presets().map(([id, name, desc]) => html`<button type="button" class=${`preset ${current === id ? 'on' : ''}`} role="radio" aria-checked=${current === id} onClick=${() => pick(id)}>
          <span class="radio"></span><span><b>${name}</b>${id === 'classic' ? html` <span class="faint small">${t('new.recommended', 'recommended')}</span>` : ''}</span><span class="desc">${desc}</span></button>`)}
      </div>
      ${open && html`<div class="grid-2" style="gap:12px 22px">
        <div class="stack-s">
          ${defs.filter((d) => d.kind === 'check').map(control)}
          <div class="stack-s"><b class="small">${t('nz.centers', 'Pokémon Center limit')} <${Honour} /></b>${center}
            <span class="tiny faint">${t('nz.centersHint', 'Visits per badge – you count them in the sidebar while playing.')}</span></div>
        </div>
        <div class="stack">
          ${defs.filter((d) => d.kind === 'choice').map((d) => html`<div class="stack-s"><b class="small">${d.label}</b>${control(d)}${d.hint && html`<span class="tiny faint">${d.hint}</span>`}</div>`)}
        </div>
      </div>`}
    </div>`;
  }

  const row = (d) => (d.kind === 'check' ? control(d) : html`<${RuleRow} title=${d.label} hint=${d.hint} honour=${d.honour}>${control(d)}<//>`);
  const section = (id) => defs.filter((d) => d.section === id).map(row);
  return html`<div class="stack-l">
    <section class="stack">
      <div class="rule-presets" role="radiogroup" aria-label=${t('nzr.presets', 'Rule set')}>
        ${presets().map(([id, name, desc]) => html`<button type="button" class=${`rule-preset ${id} ${current === id ? 'on' : ''}`} role="radio" aria-checked=${current === id} onClick=${() => pick(id)}>
          <span class="rp-top"><span class="radio"></span><b>${name}</b></span><span class="rp-desc">${desc}</span></button>`)}
      </div>
    </section>
    <section class="panel stack">
      <h2>${t('nz.core', 'Core rules')}</h2>
      <${RuleCheck} checked=${true} disabled=${true} onChange=${() => {}} label=${t('nz.firstEncounter', 'Only the first encounter per area may be caught')}
        hint=${t('nz.firstEncounterHint', 'Always on – it is what makes a Nuzlocke. Catches are filed by where they were met.')} />
      ${section('core')}
    </section>
    <section class="panel stack">
      <h2>${t('nz.clauses', 'Clauses')}</h2>
      ${section('clauses')}
    </section>
    <section class="panel stack">
      <h2>${t('nz.hardcoreRules', 'Hardcore rules')}</h2>
      ${section('hardcore')}
      <${RuleRow} title=${t('nz.centers', 'Pokémon Center limit')} honour=${true} hint=${t('nz.centersHint', 'Visits per badge – you count them in the sidebar while playing.')}>${center}<//>
    </section>
  </div>`;
}
