# Multi-account picker provider matrix

**Status:** Reconciled to the current [account-routing contract](../../architecture/model-picker-account-routing.md). The former three-policy proposal was retired; its details remain in Git history.

| Provider | Account representation | Selection behavior | Account data |
| --- | --- | --- | --- |
| `opencode` (Zen) | Connected Zen identity, optional qualified legacy model alias | **Adaptive**, **Round Robin**, or an independent explicit account pin | Unified Zen account roster and window quota projections |
| `opencode-go` (Go) | Connected Zen/Go identity, optional qualified legacy model alias | **Adaptive**, **Round Robin**, or an independent explicit account pin | Unified account roster and Go allowance windows |
| `workbuddy` | Provider-owned `@wb-...` catalog-qualified account variants | WorkBuddy's provider-default routing or explicit catalog account selection; *not* a Zen/Go account-strategy control | WorkBuddy credit and model-entitlement projections |
| `openrouter` | One provider key with separately selectable upstream providers | OpenRouter-specific upstream selection, independent of OpenFork Zen/Go account strategies | Provider quota and credits |
| Other providers | Provider-native model IDs | Provider-specific; never implicitly enroll in the hosted account strategy router | Provider-owned |

The account submenu displays live connected identities without disabling manual pin selection based solely on visible remaining usage. The provider-route resolver remains the authority for credential eligibility at execution time. No routing-strategy token is encoded into a model ID, and manual pins must not be silently replaced by another credential.
