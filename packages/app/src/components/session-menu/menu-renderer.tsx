import { For, Show } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
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
  return (
    <Show
      when={props.item.kind === "submenu"}
      fallback={
        <Show when={(props.item as Extract<MenuItemDef, { kind: "item" }>).id !== "__separator"} fallback={<MenuV2.Separator />}>
          <MenuV2.Item
            disabled={(props.item as Extract<MenuItemDef, { kind: "item" }>).disabled}
            onSelect={(props.item as Extract<MenuItemDef, { kind: "item" }>).onSelect}
          >
            <Show
              when={(props.item as Extract<MenuItemDef, { kind: "item" }>).variant === "danger"}
              fallback={(props.item as Extract<MenuItemDef, { kind: "item" }>).label}
            >
              <span class="text-v2-state-text-danger">{(props.item as Extract<MenuItemDef, { kind: "item" }>).label}</span>
            </Show>
          </MenuV2.Item>
        </Show>
      }
    >
      <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
        <MenuV2.SubTrigger disabled={(props.item as Extract<MenuItemDef, { kind: "submenu" }>).disabled}>
          {(props.item as Extract<MenuItemDef, { kind: "submenu" }>).label}
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
