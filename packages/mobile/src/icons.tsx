import type { JSX } from "solid-js"

type IconProps = { size?: number; class?: string }

function base(paths: JSX.Element, props: IconProps) {
  return (
    <svg
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      {paths}
    </svg>
  )
}

export function IconSessions(props: IconProps) {
  return base(
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </>,
    props,
  )
}

export function IconChat(props: IconProps) {
  return base(
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4h-1A2.5 2.5 0 0 1 2 13.5v-6" />,
    props,
  )
}

export function IconLimits(props: IconProps) {
  return base(
    <>
      <path d="M4 20V10" />
      <path d="M11 20V4" />
      <path d="M18 20v-7" />
    </>,
    props,
  )
}

export function IconSettings(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.75.85.34.2.68.24 1.09.24H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>,
    props,
  )
}

export function IconChevron(props: IconProps) {
  return base(<path d="m6 9 6 6 6-6" />, props)
}

export function IconClose(props: IconProps) {
  return base(
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>,
    props,
  )
}

export function IconArchive(props: IconProps) {
  return base(
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 13h4" />
    </>,
    props,
  )
}

export function IconTrash(props: IconProps) {
  return base(
    <>
      <path d="M4 7h16" />
      <path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>,
    props,
  )
}

export function IconPlus(props: IconProps) {
  return base(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
    props,
  )
}

export function IconArrowUpRight(props: IconProps) {
  return base(
    <>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </>,
    props,
  )
}

export function IconLogout(props: IconProps) {
  return base(
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>,
    props,
  )
}

export function IconRefresh(props: IconProps) {
  return base(
    <>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </>,
    props,
  )
}

export function IconChevronLeft(props: IconProps) {
  return base(<path d="m15 18-6-6 6-6" />, props)
}

export function IconChevronRight(props: IconProps) {
  return base(<path d="m9 18 6-6-6-6" />, props)
}

export function IconChevronDown(props: IconProps) {
  return base(<path d="m6 9 6 6 6-6" />, props)
}

export function IconMore(props: IconProps) {
  return base(
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>,
    props,
  )
}

export function IconGitBranch(props: IconProps) {
  return base(
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 8.2V15.8" />
      <path d="M18 11.2V13a4 4 0 0 1-4 4H10" />
    </>,
    props,
  )
}

export function IconCpu(props: IconProps) {
  return base(
    <>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>,
    props,
  )
}

export function IconBarChart(props: IconProps) {
  return base(
    <>
      <path d="M4 20V10" />
      <path d="M11 20V4" />
      <path d="M18 20v-7" />
    </>,
    props,
  )
}

export function IconFileEdit(props: IconProps) {
  return base(
    <>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
      <path d="M13 3v5h5" />
      <path d="m14.5 12.5 3 3L20 13l-3-3-2.5 2.5Z" />
    </>,
    props,
  )
}

export function IconAlertTriangle(props: IconProps) {
  return base(
    <>
      <path d="M10.3 3.9 1.9 18a1.6 1.6 0 0 0 1.4 2.4h17.4a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>,
    props,
  )
}

export function IconWifiOff(props: IconProps) {
  return base(
    <>
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.5a10 10 0 0 1 3.5-2.3" />
      <path d="M19 12.5a10 10 0 0 0-2.5-1.9" />
      <path d="M2 8.5a15 15 0 0 1 4-2.4" />
      <path d="M22 8.5a15 15 0 0 0-6-3.3" />
      <path d="M12 20h.01" />
    </>,
    props,
  )
}

export function IconCheckCircle(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </>,
    props,
  )
}

export function IconXCircle(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9.5 9.5 5 5" />
      <path d="m14.5 9.5-5 5" />
    </>,
    props,
  )
}

export function IconBell(props: IconProps) {
  return base(
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>,
    props,
  )
}

export function IconArrowDown(props: IconProps) {
  return base(
    <>
      <path d="M12 4v16" />
      <path d="m6 14 6 6 6-6" />
    </>,
    props,
  )
}

export function IconSearch(props: IconProps) {
  return base(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>,
    props,
  )
}

export function IconSliders(props: IconProps) {
  return base(
    <>
      <path d="M5 21V13" />
      <path d="M5 9V3" />
      <path d="M12 21v-4" />
      <path d="M12 13V3" />
      <path d="M19 21v-6" />
      <path d="M19 11V3" />
      <circle cx="5" cy="11" r="1.8" />
      <circle cx="12" cy="15" r="1.8" />
      <circle cx="19" cy="13" r="1.8" />
    </>,
    props,
  )
}

export function IconPin(props: IconProps) {
  return base(
    <>
      <path d="M12 2c2.5 0 4.5 2 4.5 4.5 0 2.5-4.5 8-4.5 8s-4.5-5.5-4.5-8C7.5 4 9.5 2 12 2Z" />
      <circle cx="12" cy="6.5" r="1.6" />
      <path d="M12 14.5V22" />
    </>,
    props,
  )
}

export function IconClock(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
    props,
  )
}

export function IconStar(props: IconProps) {
  return base(
    <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8l-6.2 3.3 1.2-6.9-5-4.9 6.9-1L12 2Z" />,
    props,
  )
}

export function IconFolder(props: IconProps) {
  return base(
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9.5A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />,
    props,
  )
}

export function IconCommand(props: IconProps) {
  return base(
    <>
      <path d="M8 3.5A2.5 2.5 0 1 0 5.5 6H8v2H5.5A2.5 2.5 0 1 0 8 10.5V8h8v2.5A2.5 2.5 0 1 0 18.5 8H16V6h2.5A2.5 2.5 0 1 0 16 3.5V6H8Z" />
    </>,
    props,
  )
}

export function IconBrain(props: IconProps) {
  return base(
    <>
      <path d="M9 4a3 3 0 0 0-3 3v.3A3 3 0 0 0 4 10v1a3 3 0 0 0 1 2.2V15a3 3 0 0 0 3 3h1" />
      <path d="M15 4a3 3 0 0 1 3 3v.3a3 3 0 0 1 2 2.7v1a3 3 0 0 1-1 2.2V15a3 3 0 0 1-3 3h-1" />
      <path d="M9 4v15" />
      <path d="M15 4v15" />
    </>,
    props,
  )
}

export function IconInfo(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>,
    props,
  )
}

export function IconBot(props: IconProps) {
  return base(
    <>
      <rect x="4" y="9" width="16" height="10" rx="2.5" />
      <path d="M12 3v4" />
      <circle cx="12" cy="3" r="1.2" />
      <path d="M8 14h.01" />
      <path d="M16 14h.01" />
      <path d="M9 18h6" />
    </>,
    props,
  )
}

export function IconCopy(props: IconProps) {
  return base(
    <>
      <rect x="9" y="9" width="12" height="12" rx="1.8" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>,
    props,
  )
}

export function IconBan(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.5 5.5 13 13" />
    </>,
    props,
  )
}

export function IconEye(props: IconProps) {
  return base(
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    props,
  )
}

export function IconTerminal(props: IconProps) {
  return base(
    <>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 18h7" />
    </>,
    props,
  )
}

export function IconGitMerge(props: IconProps) {
  return base(
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M18 15.8V11a5 5 0 0 0-5-5H9" />
    </>,
    props,
  )
}

export function IconRotateCcw(props: IconProps) {
  return base(
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.3L3 8" />
      <path d="M3 3v5h5" />
    </>,
    props,
  )
}

export function IconExternalLink(props: IconProps) {
  return base(
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </>,
    props,
  )
}

export function IconMinus(props: IconProps) {
  return base(<path d="M5 12h14" />, props)
}

export function IconSend(props: IconProps) {
  return base(
    <>
      <path d="M4.5 3.5 20 12 4.5 20.5 6.5 12Z" />
      <path d="M6.5 12H20" />
    </>,
    props,
  )
}

export function IconSquare(props: IconProps) {
  return base(<rect x="6" y="6" width="12" height="12" rx="2" />, props)
}

export function IconAtSign(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M16.2 12v1.3a2.3 2.3 0 0 0 4.6 0V12a8.8 8.8 0 1 0-3.5 7" />
    </>,
    props,
  )
}

export function IconPaperclip(props: IconProps) {
  return base(
    <path d="M20 11.5 11.3 20.2a4.5 4.5 0 0 1-6.4-6.4l8.5-8.5a3 3 0 0 1 4.2 4.2L9.2 18a1.5 1.5 0 0 1-2.1-2.1l7.4-7.4" />,
    props,
  )
}

export function IconZap(props: IconProps) {
  return base(<path d="M12.5 2 4 14h6l-1 8L20 10h-6l-1.5-8Z" />, props)
}

export function IconGlobe(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </>,
    props,
  )
}

export function IconShieldAlert(props: IconProps) {
  return base(
    <>
      <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="M12 8.5v4" />
      <path d="M12 15.5h.01" />
    </>,
    props,
  )
}

export function IconShieldCheck(props: IconProps) {
  return base(
    <>
      <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="m9.2 12.2 2 2 3.6-3.9" />
    </>,
    props,
  )
}

export function IconShield(props: IconProps) {
  return base(<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />, props)
}

export function IconHelpCircle(props: IconProps) {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 1.8" />
      <path d="M12 17h.01" />
    </>,
    props,
  )
}

export function IconCheck(props: IconProps) {
  return base(<path d="m5 12.5 4.5 4.5L19 7" />, props)
}

export function IconDatabase(props: IconProps) {
  return base(
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5V18a8 3 0 0 0 16 0V5.5" />
      <path d="M4 12a8 3 0 0 0 16 0" />
    </>,
    props,
  )
}

export function IconTrendingUp(props: IconProps) {
  return base(
    <>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </>,
    props,
  )
}

export function IconDollar(props: IconProps) {
  return base(
    <>
      <path d="M12 2v20" />
      <path d="M17 6.5c0-1.9-2-3-5-3s-5 1.1-5 2.8c0 3.7 10 1.7 10 5.9 0 1.9-2.2 3.3-5 3.3s-5-1.4-5-3.3" />
    </>,
    props,
  )
}

export function IconWrench(props: IconProps) {
  return base(
    <path d="M14.7 6.3a4 4 0 0 0-5.4 4.9L3 17.5V21h3.5l6.3-6.3a4 4 0 0 0 4.9-5.4l-2.8 2.8-2.5-.5-.5-2.5 2.8-2.8Z" />,
    props,
  )
}

export function IconPackage(props: IconProps) {
  return base(
    <>
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
      <path d="M3.3 7 12 2l8.7 5v10L12 22l-8.7-5Z" />
    </>,
    props,
  )
}

export function IconKey(props: IconProps) {
  return base(
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.6 12.4 8.9-8.9" />
      <path d="m15 8 3 3" />
      <path d="m18 5 3 3" />
    </>,
    props,
  )
}

export function IconMoon(props: IconProps) {
  return base(<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z" />, props)
}

export function IconWifi(props: IconProps) {
  return base(
    <>
      <path d="M2 8.5a15 15 0 0 1 20 0" />
      <path d="M5 12.5a10 10 0 0 1 14 0" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M12 20h.01" />
    </>,
    props,
  )
}

export function IconDownload(props: IconProps) {
  return base(
    <>
      <path d="M12 3v13" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 21h16" />
    </>,
    props,
  )
}

export function IconGrid(props: IconProps) {
  return base(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" />
    </>,
    props,
  )
}

export function IconImage(props: IconProps) {
  return base(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-5-5-9 9" />
    </>,
    props,
  )
}

export function IconX(props: IconProps) {
  return base(
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>,
    props,
  )
}
