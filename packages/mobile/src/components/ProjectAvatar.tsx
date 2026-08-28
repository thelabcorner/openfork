const COLORS = ["#e0507a", "#5b8dff", "#a78bfa", "#4ade80", "#fab283", "#f59e0b", "#22c1c3", "#f87171"]

function hashIndex(id: string, mod: number) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % mod
}

export function ProjectAvatar(props: { name: string; size?: number }) {
  const color = () => COLORS[hashIndex(props.name, COLORS.length)]
  const letter = () => (props.name.trim().charAt(0) || "?").toUpperCase()
  const size = () => props.size ?? 18
  return (
    <span
      class="project-avatar"
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        "font-size": `${Math.round(size() * 0.55)}px`,
        background: color(),
      }}
    >
      {letter()}
    </span>
  )
}
