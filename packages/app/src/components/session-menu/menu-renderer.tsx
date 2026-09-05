import { createSignal, For, Show } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { MenuItemDef, MenuSectionDef } from "./menu-model"

export function MenuSectionsRenderer(props: { sections: MenuSectionDef[] }) {
  return (
    <>
      <For each={props.sections}>
        {(section, idx) => (
          <>
            <For each={section.items}>{(item) => <MenuItemRenderer item={item} />}</For>
            <Show when={idx() < props.sections.length - 1}>
              <MenuV2.Separator />
            </Show>
          </>
        )}
      </For>
    </>
  )
}

function MenuItemRenderer(props: { item: MenuItemDef }) {
  const iconName = (props.item as any).icon as string | undefined

  const renderWithIcon = (children: any) => (
    <span class="flex w-full min-w-0 items-center gap-[7px]">
      <Show when={iconName}>
        <span data-slot="menu-v2-item-icon">
          <Icon name={iconName as any} size="small" />
        </span>
      </Show>
      {children}
    </span>
  )

  return (
    <Show
      when={props.item.kind === "submenu"}
      fallback={
        <Show
          when={props.item.kind === "checkbox"}
          fallback={
            <Show
              when={props.item.kind === "radio"}
              fallback={
                <Show when={(props.item as Extract<MenuItemDef, { kind: "item" }>).id !== "__separator"} fallback={<MenuV2.Separator />}>
                  <MenuV2.Item
                    disabled={(props.item as Extract<MenuItemDef, { kind: "item" }>).disabled}
                    onSelect={(props.item as Extract<MenuItemDef, { kind: "item" }>).onSelect}
                  >
                    <Show
                      when={(props.item as Extract<MenuItemDef, { kind: "item" }>).variant === "danger"}
                      fallback={renderWithIcon((props.item as Extract<MenuItemDef, { kind: "item" }>).label)}
                    >
                      <span class="text-v2-state-text-danger flex w-full min-w-0 items-center gap-[7px]">
                        <Show when={iconName}>
                          <span data-slot="menu-v2-item-icon">
                            <Icon name={iconName as any} size="small" />
                          </span>
                        </Show>
                        {(props.item as Extract<MenuItemDef, { kind: "item" }>).label}
                      </span>
                    </Show>
                  </MenuV2.Item>
                </Show>
              }
            >
              {/* Radio inside context menu — label with an optional avatar and a
                  trailing check for the selected value. Wrapped in a fragment
                  to avoid needing RadioGroup; check is visual only. */}
              <MenuV2.Item
                disabled={(props.item as Extract<MenuItemDef, { kind: "radio" }>).disabled}
                onSelect={(props.item as Extract<MenuItemDef, { kind: "radio" }>).onSelect}
              >
                {renderWithIcon(
                  <>
                    <Show when={(props.item as Extract<MenuItemDef, { kind: "radio" }>).avatar}>
                      {(avatar) => (
                        <ProjectAvatar
                          fallback={avatar().fallback}
                          src={avatar().src}
                          variant={avatar().variant}
                          class="shrink-0"
                        />
                      )}
                    </Show>
                    <span class="min-w-0 flex-1 truncate text-left">
                      {(props.item as Extract<MenuItemDef, { kind: "radio" }>).label}
                    </span>
                    <Show when={(props.item as Extract<MenuItemDef, { kind: "radio" }>).checked}>
                      <Icon name="check" size="small" class="shrink-0" />
                    </Show>
                  </>
                )}
              </MenuV2.Item>
            </Show>
          }
        >
          <MenuV2.Item
            disabled={(props.item as Extract<MenuItemDef, { kind: "checkbox" }>).disabled}
            onSelect={(props.item as Extract<MenuItemDef, { kind: "checkbox" }>).onSelect}
          >
            {renderWithIcon(
              <>
                <span class={`flex size-3.5 items-center justify-center rounded-sm border shrink-0 ${ (props.item as Extract<MenuItemDef, { kind: "checkbox" }>).checked ? "bg-v2-state-fg-success border-v2-state-fg-success text-white" : "border-v2-border-border-muted"}`}>
                  <Show when={(props.item as Extract<MenuItemDef, { kind: "checkbox" }>).checked}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 8L6.5 11L12.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </Show>
                </span>
                {(props.item as Extract<MenuItemDef, { kind: "checkbox" }>).label}
              </>
            )}
          </MenuV2.Item>
        </Show>
      }
    >
      <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
        <MenuV2.SubTrigger disabled={(props.item as Extract<MenuItemDef, { kind: "submenu" }>).disabled}>
          {renderWithIcon((props.item as Extract<MenuItemDef, { kind: "submenu" }>).label)}
        </MenuV2.SubTrigger>
        <MenuV2.Portal>
          <MenuV2.SubContent
            class="max-w-[260px]"
            classList={{ "w-[243px]": !!(props.item as Extract<MenuItemDef, { kind: "submenu" }>).search }}
          >
            <SubmenuContent item={props.item as Extract<MenuItemDef, { kind: "submenu" }>} />
          </MenuV2.SubContent>
        </MenuV2.Portal>
      </MenuV2.Sub>
    </Show>
  )
}

/**
 * Submenu body with optional search filtering. In search mode the radio
 * options scroll inside the shared ScrollView (no x-scroll; custom thumb),
 * while search and action rows (add-project) stay pinned outside the list.
 * Search matches radio-item labels case-insensitively; a lone separator
 * above zero matches is hidden.
 */
function SubmenuContent(props: { item: Extract<MenuItemDef, { kind: "submenu" }> }) {
  const [search, setSearch] = createSignal("")

  const radios = () => {
    const query = search().trim().toLowerCase()
    const options = props.item.items.filter((item) => item.kind === "radio")
    if (!query) return options
    return options.filter((item) => item.label.toLowerCase().includes(query))
  }
  const pinned = () => {
    const actions = props.item.items.filter((item) => item.kind !== "radio")
    if (radios().length > 0) return actions
    return actions.filter((item) => item.id !== "__separator")
  }

  return (
    <>
      <Show when={props.item.search}>
        {(config) => (
          <div class="flex h-7 items-center gap-2 px-3 text-v2-icon-icon-muted">
            <Icon name="magnifying-glass" size="small" class="shrink-0" />
            <input
              autofocus
              value={search()}
              placeholder={config().placeholder}
              aria-label={config().placeholder}
              class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-v2-text-text-faint"
              onInput={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Keep keystrokes local so menu typeahead doesn't steal them;
                // Escape still bubbles so the menu dismisses.
                if (event.key !== "Escape") event.stopPropagation()
              }}
            />
          </div>
        )}
      </Show>
      <Show when={props.item.search} fallback={<For each={props.item.items}>{(sub) => <MenuItemRenderer item={sub} />}</For>}>
        <ScrollView class="max-h-[224px]">
          <For each={radios()}>{(sub) => <MenuItemRenderer item={sub} />}</For>
        </ScrollView>
        <For each={pinned()}>{(sub) => <MenuItemRenderer item={sub} />}</For>
      </Show>
    </>
  )
}
