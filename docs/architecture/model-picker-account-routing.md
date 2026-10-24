# Model-picker account routing: capability and catalog boundaries

The OpenFork model selector is shared by composer and session menus **and** model-only
configuration fields (Goal agents, scheduled tasks, and Settings). Those fields
do not all persist the same type of selection.

## Authoritative path

Hosted Zen/Go account policy lives in the provider-route intent and durable
session routing domain. The selector consumes the model catalog plus existing
quota/account projections; it does not decide which account executes a turn.
The selection path is:

`ProviderRouteIntent` (Schema) → persisted session/composer selection →
provider-route resolver (Core / V1 bridge) → account binding/lease →
selector's model state capability → account submenu.

The presentation boundary is `model-hosted-account-selection.ts`. Its
`hostedAccountRoutingStrategies` and `showAccountSubmenu` predicates must be
used consistently for submenu rendering **and** pooled-tooltip suppression.

## Invariants

- Hosted `opencode` / `opencode-go` with persistent `routeIntent` and more than
  one live account: offer exactly **Adaptive** and **Round Robin** as strategies,
  and offer independent explicit account pinning. Account routes remain sticky across ordinary
  healthy Session steps, but an explicit change of strategy triggers a fresh
  transactional policy selection and updates the binding mode. Explicitly
  switching from a manual pin to a strategy releases that pin and selects
  under the chosen strategy. A missing unqualified catalog entry does **not**
  change which strategies are available.
- Hosted strategy choices (Adaptive / Round Robin) are offered only when the
  live account roster has **more than one** account. With zero or one
  account/key there is nothing to route across, so the Routing section is
  omitted (the submenu falls back to the Provider default row). Account *pins*
  follow the submenu gate, not the strategy gate. Rendering must not fabricate
  accounts or credential identities. Direct-provider and model-only pickers
  retain their existing capability gates.
- **Only Adaptive and Round Robin exist as hosted automatic account-selection
  policies.** Their common wire intent is `routeIntent.kind: "strategy"`;
  its `strategy` field selects `adaptive` or `round-robin`, and omission
  defaults to Adaptive. Shared Schema `ProviderRouteIntent.effectiveStrategy`
  owns that default. No third account-selection policy exists.
  Obsolete serialized `kind: "auto"` records decode to Adaptive/Round Robin
  through a one-way compatibility decoder; canonical runtime and encoding
  never emit that obsolete discriminator.
- Explicit `kind: "account"` means a manual account pin, and `kind: "public"`
  is upstream Public transport selection. Neither is an account-routing
  strategy. Internal Core routing modes (`concentrate`,
  `session-round-robin`, `round-robin`) are implementation mechanisms, not
  additional model-picker policies. Hosted Adaptive maps to `concentrate`,
  prioritizing eligible accounts by time-adjusted allowance urgency and usage;
  Round Robin maps to `round-robin` and ignores quota-ranking bias.
- The shared runtime ignores hosted routing-strategy hints for unrelated
  providers even if a legacy/stale or external client sends one. A provider
  switch cannot silently turn a third-party route into a round-robin pool.
- Model-only settings, scheduled-task, and Goal-agent selectors: no hosted
  routing choices or account pins. Their existing storage contract is
  provider/model identity, not a persistent route intent. Never offer an action
  that will throw, be dropped, or silently turn into an unqualified model.
- Catalog-variant providers (currently WorkBuddy) retain qualified model IDs.
  Their unqualified entry is **Provider default** under **Account choice**,
  not a simulated Adaptive/Round-robin strategy. Do not change transport
  behavior by relabeling a catalog alias.
- The pooled tooltip must be present when there is no usable account submenu,
  including model-only pickers; it is suppressed only for a rendered account
  submenu. No extra per-row quota requests, account projections, or timers.
- A refreshed roster with the same IDs and labels but reordered delivery must
  not churn submenu state or reshuffle click targets. Explicit account clicks
  are revalidated against the latest displayed roster before changing local
  model selection. Final account eligibility remains server-owned.
- Hosted submenu account rows are built exclusively from the live Zen/Go roster,
  even when that roster is empty. Cached account-qualified catalog variants
  must never resurrect a revoked account. A search hit on an old
  `model@account` alias uses a compatible account-neutral catalog group,
  strips the legacy suffix and keeps the newly selected routing strategy or
  account pin separate from the model identity. Mismatched catalog groups are
  ignored. Covered by `model-hosted-account-selection.test.ts` and the shared
  selector integration in `dialog-select-model.tsx`.

### Qualified-only hosted catalog execution (October 15)

V1 `Provider.getModel` and the bootstrap-free `ProviderCatalog.list` must
agree when a legitimate upstream Zen/Go catalog contains only legacy
`model@zen-account` entries. The provider-owned pure projection
`src/provider/hosted-neutral-model.ts` derives an account-neutral
**metadata** row only when all known qualified aliases agree on the same
unqualified API model, expected official Zen/Go HTTPS endpoint, capabilities,
price, limits, options and other execution-relevant metadata. It rejects
malformed aliases, account-specific transport/auth overrides, conflicting
siblings, disallowed or unavailable bases, and wrong-provider identities;
existing account-neutral catalog rows always take precedence. The original
qualified rows remain available for legacy identity lookup.

The V1 runtime applies this at provider finalization and after provider
discovery. `ProviderCatalog.list` applies the same pure projection when
assembling the bootstrap-free listing. When the normal trusted catalog lacks
the base, `materializeZenCompatModel` accepts an *independently reconstructed*
qualified-only witness **only after the actual exact account route is
committed**. It constructs a minimal clean provider, drops ambient auth/options,
and installs only the committed Zen account's transport. This never becomes
an upstream Public witness: Public eligibility still requires the existing
trusted models.dev/catalog, published hosted /models and route-health proofs.
Console account materialization independently validates the selected account's
own capabilities, as before.

Receipts: `test/provider/hosted-neutral-model.test.ts` (positive and
adversarial pure cases), `test/provider/provider-catalog.test.ts` (independent
catalog projection + restrictions), `test/provider/provider.test.ts` (V1
selection and foreign-origin denial), and
`test/provider/console-account-execution.test.ts` (real ProviderRoute account
commit and mocked upstream chat response, exact Authorization bearer and
dequalified model ID, no Public fallback). No live upstream service was used
by these tests; this is not a production external-service acceptance receipt.
- The Core account policy has deterministic 1/3/6-session independent SQLite
  connection tests for both strategies. These check initial durable cursor
  epochs, binding cardinality, policy assignment counts, and two-session-per-
  account caps under concurrent assignment. They are unit/integration receipts,
  not a claim of live remote-provider certification.

Routing semantics must be added at the domain owner first if a model-only
configuration field ever needs a persistent account policy. Do not solve that
future feature with a UI-local preference or invented `@account` model ID.

## Execution verification limitations

Source-level and package-level tests validate the above routing and display
projections. A full live renderer/pointer test additionally requires the
already-running Electron dev renderer and its own sidecar, never a synthetic
backend on a random port. On October 15, the existing
`localhost:9222/json/list` CDP endpoint and the `localhost:5173` renderer
were both unavailable (`ECONNREFUSED`), and OXP reported no registered shared
Desktop browser host. In accordance with `packages/app/AGENTS.md` the
investigation did not start or restart any app/backend process. Do not report
live UI certification from a pure DOM or model-helper unit test.