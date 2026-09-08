import { createUniqueId, type ComponentProps } from "solid-js"

/**
 * OpenFork wordmark built on the same 18.46px modular grid as the OpenCode
 * wordmark. Keeping it as SVG geometry preserves the crisp, low-opacity
 * treatment used by the new-session surface at every display scale.
 */
export function OpenForkWordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      role="img"
      aria-label="OpenFork"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            {/* o */}
            <path
              opacity="0.7"
              d="M55.3846 36.4286H18.4615V91.7143H55.3846V36.4286ZM73.8462 110.143H0V18H73.8462V110.143Z"
              fill="currentColor"
            />
            {/* p */}
            <path
              opacity="0.7"
              d="M110.462 91.7143H147.385V36.4286H110.462V91.7143ZM165.846 110.143H110.462V128.571H92V18H165.846V110.143Z"
              fill="currentColor"
            />
            {/* e */}
            <path
              opacity="0.7"
              d="M258.846 73.2857H203.462V91.7143H258.846V110.143H185V18H258.846V73.2857ZM203.462 54.8571H240.385V36.4286H203.462V54.8571Z"
              fill="currentColor"
            />
            {/* n */}
            <path
              opacity="0.7"
              d="M332.385 36.4286H295.462V110.143H277V18H332.385V36.4286ZM350.846 110.143H332.385V36.4286H350.846V110.143Z"
              fill="currentColor"
            />
            {/* f */}
            <path
              opacity="0.7"
              d="M442.846 18H369V110.143H387.462V73.2857H424.385V54.8571H387.462V36.4286H442.846V18Z"
              fill="currentColor"
            />
            {/* o */}
            <path
              opacity="0.7"
              d="M517.385 36.4286H480.462V91.7143H517.385V36.4286ZM535.846 110.143H462V18H535.846V110.143Z"
              fill="currentColor"
            />
            {/* r */}
            <path
              opacity="0.7"
              d="M554 18H609.385V36.4286H572.462V110.143H554V18ZM627.846 54.8571H609.385V36.4286H627.846V54.8571Z"
              fill="currentColor"
            />
            {/* k */}
            <path
              opacity="0.7"
              d="M646 18H664.462V54.8571H682.923V36.4286H701.385V18H719.846V36.4286H701.385V54.8571H682.923V73.2857H701.385V91.7143H719.846V110.143H701.385V91.7143H682.923V73.2857H664.462V110.143H646V18Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
