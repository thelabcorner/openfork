import { For, Show } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
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
              {/* Radio inside context menu — render as checkable item with dot indicator.
                  Wrapped in a fragment to avoid needing RadioGroup; check is visual only. */}
              <MenuV2.Item
                disabled={(props.item as Extract<MenuItemDef, { kind: "radio" }>).disabled}
                onSelect={(props.item as Extract<MenuItemDef, { kind: "radio" }>).onSelect}
              >
                {renderWithIcon(
                  <>
                    <span class={`size-2 rounded-full shrink-0 ${ (props.item as Extract<MenuItemDef, { kind: "radio" }>).checked ? "bg-v2-state-fg-success" : "bg-transparent border border-v2-border-border-muted"}`} />
                    {(props.item as Extract<MenuItemDef, { kind: "radio" }>).label}
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
          <MenuV2.SubContent class="max-w-[260px]">
            <For each={(props.item as Extract<MenuItemDef, { kind: "submenu" }>).items}>
              {(sub) => <MenuItemRenderer item={sub} />}
            </For>
          </MenuV2.SubContent>
        </MenuV2.Portal>
      </MenuV2.Sub>
    </Show>
  )
}
