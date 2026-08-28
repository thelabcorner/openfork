import { onMount, type ComponentProps, splitProps } from "solid-js"

const icons = {
  compare: {
    viewBox: "0 0 16 16",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M8 1.5C7.724 1.5 7.5 1.724 7.5 2V3.13C5.8 3.5 4.5 5 4.5 6.8C4.5 8.6 5.8 10.1 7.5 10.47V12.5H6.1C5.62 12.5 5.5 13.2 5.9 13.5H10.1C10.5 13.2 10.38 12.5 9.9 12.5H8.5V10.47C10.2 10.1 11.5 8.6 11.5 6.8C11.5 5 10.2 3.5 8.5 3.13V2C8.5 1.724 8.276 1.5 8 1.5ZM8 4.1C9.49 4.1 10.7 5.31 10.7 6.8C10.7 8.29 9.49 9.5 8 9.5C6.51 9.5 5.3 8.29 5.3 6.8C5.3 5.31 6.51 4.1 8 4.1Z" fill="currentColor"/>`,
  },
  pin: {
    viewBox: "0 0 16 16",
    body: `<path d="M9.5 1.5L14.5 6.5L11.75 9.25L11.9 12.1L9.9 14.1L6.9 11.1L3.5 14.5L3 14L6.4 10.6L3.4 7.6L5.4 5.6L8.25 5.75L11 3L9.5 1.5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "pin-filled": {
    viewBox: "0 0 16 16",
    body: `<path d="M9.5 1.5L14.5 6.5L11.75 9.25L11.9 12.1L9.9 14.1L6.9 11.1L3.5 14.5L3 14L6.4 10.6L3.4 7.6L5.4 5.6L8.25 5.75L11 3L9.5 1.5Z" fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  download: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2V10M8 10L5 7M8 10L11 7M2.5 12.5H13.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  edit: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor"/>`,
  },
  "folder-add-left": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.5 13.3333H1.5V2H6.83333L8.83333 4H14.8333V6M10.1667 11.3333H15.5M12.8333 8.66667V14" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  folder: {
    viewBox: "0 0 16 16",
    body: `<path d="M2.545 3.364V12.636H13.455V5H8.545L6.909 3.364H2.545Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  branch: {
    viewBox: "0 0 16 16",
    body: `<path d="M5.118 5.686V10.314M5.118 5.686C5.97 5.686 6.661 4.995 6.661 4.143C6.661 3.291 5.97 2.6 5.118 2.6C4.266 2.6 3.575 3.291 3.575 4.143C3.575 4.995 4.266 5.686 5.118 5.686ZM5.118 10.314C4.266 10.314 3.575 11.005 3.575 11.857C3.575 12.709 4.266 13.4 5.118 13.4C5.97 13.4 6.661 12.709 6.661 11.857M5.118 10.314C5.97 10.314 6.661 11.005 6.661 11.857M10.882 5.686C11.734 5.686 12.425 4.995 12.425 4.143C12.425 3.291 11.734 2.6 10.882 2.6C10.03 2.6 9.339 3.291 9.339 4.143C9.339 4.995 10.03 5.686 10.882 5.686ZM10.882 5.686V9.457C10.882 10.783 9.807 11.857 8.482 11.857H6.661" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "grid-plus": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  globe: {
    viewBox: "0 0 20 20",
    body: `<circle cx="10" cy="10" r="7.25" stroke="currentColor"/><path d="M2.75 10H17.25" stroke="currentColor"/><ellipse cx="10" cy="10" rx="3" ry="7.25" stroke="currentColor"/>`,
  },
  help: {
    viewBox: "0 0 16 16",
    body: `<path d="M6.33345 6.33349V5.00015H9.66679V7.00015L8.00015 8.00015V9.66679M8.27485 11.6819H7.71897M14.4446 8.00011C14.4446 11.5593 11.5593 14.4446 8.00011 14.4446C4.44094 14.4446 1.55566 11.5593 1.55566 8.00011C1.55566 4.44094 4.44094 1.55566 8.00011 1.55566C11.5593 1.55566 14.4446 4.44094 14.4446 8.00011Z" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "sidebar-right": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z" fill="currentColor"/>`,
  },
  status: {
    viewBox: "0 0 20 20",
    body: `<path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "status-active": {
    viewBox: "0 0 20 20",
    body: `<path d="M18 2H2V10H18V2Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 18H18V10H2V18Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "magnifying-glass": {
    viewBox: "0 0 16 16",
    body: `<path d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z" stroke="currentColor"/>`,
  },
  menu: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 8H14M2 4.664H14M2 11.336H14" stroke="currentColor"/>`,
  },
  grip: {
    viewBox: "0 0 16 16",
    body: `<circle cx="5.5" cy="4.5" r="1.25" fill="currentColor"/><circle cx="10.5" cy="4.5" r="1.25" fill="currentColor"/><circle cx="5.5" cy="8" r="1.25" fill="currentColor"/><circle cx="10.5" cy="8" r="1.25" fill="currentColor"/><circle cx="5.5" cy="11.5" r="1.25" fill="currentColor"/><circle cx="10.5" cy="11.5" r="1.25" fill="currentColor"/>`,
  },
  plus: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2.88867V13.1109" stroke="currentColor" stroke-linejoin="round"/><path d="M2.88867 8H13.1109" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "settings-gear": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.99998 1.3335L14 4.66683V11.3335L7.99998 14.6668L2 11.3335V4.66683L7.99998 1.3335Z" stroke="currentColor"/><path d="M9.99998 8.00016C9.99998 9.10476 9.10458 10.0002 7.99998 10.0002C6.89538 10.0002 5.99998 9.10476 5.99998 8.00016C5.99998 6.89556 6.89538 6.00016 7.99998 6.00016C9.10458 6.00016 9.99998 6.89556 9.99998 8.00016Z" stroke="currentColor"/>`,
  },
  "chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  collapse: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1V6M11 3L8 6L5 3" stroke="currentColor"/><path d="M8 15V10M11 13L8 10L5 13" stroke="currentColor"/><path d="M4 8H6" stroke="currentColor"/><path d="M7 8H9" stroke="currentColor"/><path d="M10 8H12" stroke="currentColor"/>`,
  },
  // Compact — inward arrows squeezing content into one condensed line.
  // Vertically symmetric, so it is non-directional and never mirrored for RTL
  // (rtl-aware-development skill).
  compact: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1.5V5.5M5.75 3.25L8 5.5L10.25 3.25" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 14.5V10.5M5.75 12.75L8 10.5L10.25 12.75" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 8H12.5" stroke="currentColor" stroke-linecap="round"/>`,
  },
  check: {
    viewBox: "0 0 16 16",
    body: `<path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor"/>`,
  },
  monitor: {
    viewBox: "0 0 16 16",
    body: `<path d="M4.05559 9.38889H0.500007C0.500007 9.38889 0.500017 8.59298 0.500017 7.61112V2.27778C0.500017 1.29594 0.500102 0.5 0.500102 0.5H13.3889C13.3889 0.5 13.3889 1.29594 13.3889 2.27778V7.61112C13.3889 8.59298 13.3889 9.38889 13.3889 9.38889H9.83336M4.05559 9.38889V11.6111H6.94448H9.83336V9.38889M4.05559 9.38889H9.83336" transform="translate(1.05556 1.94444)" stroke="currentColor"/>`,
  },
  "workspace-new": {
    viewBox: "0 0 16 16",
    body: `<path d="M2 10.7578V14.0011H5.24324M13.9991 5.24324V2H10.7559M13.9991 10.7578V14.0011H10.7559M2 5.24324V2H5.24324" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/><path d="M8 4.5V11.5M4.5 8H11.5" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "workspace-isolated": {
    viewBox: "0 0 16 16",
    body: `<path d="M10.5 10.5V5.5H5.5V10.5H10.5Z" fill="currentColor"/><rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor"/>`,
  },
  workspace: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 10.668V14.0013H10.6667M13.9974 10.6667V2H2.66406M13.9974 10.668V14.0013H10.6641M2 10V2H5.33333" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/><path d="M10.6693 10.6654V5.33203H5.33594V10.6654H10.6693Z" fill="currentColor"/>`,
  },
  close: {
    viewBox: "0 0 20 20",
    body: `<path d="M14.4446 5.55566L5.55566 14.4446M5.55566 5.55566L14.4446 14.4446" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "xmark-small": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor"/>`,
  },
  "outline-xmark": {
    viewBox: "0 0 16 16",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M4.99487 5.70186L7.29297 7.99995L4.99487 10.2981L5.70198 11.0052L8.00008 8.70706L10.2982 11.0052L11.0053 10.2981L8.70718 7.99995L11.0053 5.70186L10.2982 4.99475L8.00008 7.29285L5.70198 4.99475L4.99487 5.70186Z" fill="currentColor"/>`,
  },
  trash: {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 4H13.5M6 4V2.75C6 2.612 6.112 2.5 6.25 2.5H9.75C9.888 2.5 10 2.612 10 2.75V4M3.5 4L4.25 13.25C4.28 13.671 4.63 14 5.05 14H10.95C11.37 14 11.72 13.671 11.75 13.25L12.5 4M6.5 6.5V11.5M9.5 6.5V11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  "outline-chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  "outline-dots": {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor"/><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor"/><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor"/>`,
  },
  expand: {
    viewBox: "0 0 16 16",
    body: `<path d="M8.25 6.17773V1.17773M11.25 4.17773L8.25 1.17773L5.25 4.17773" stroke="currentColor"/><path d="M8.25 9.17773V14.1777M11.25 11.1777L8.25 14.1777L5.25 11.1777" stroke="currentColor"/><path d="M4.25 7.67773H12.25" stroke="currentColor"/>`,
  },
  filetree: {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 1.5V12.2484H6.75M2.5 4.74838H6.75" stroke="currentColor"/><rect x="8.5" y="3.2168" width="6" height="3" fill="none" stroke="currentColor"/><rect x="8.5" y="10.75" width="6" height="3" fill="none" stroke="currentColor"/>`,
  },
  split: {
    viewBox: "0 0 16 16",
    body: `<path d="M1 14H15L15 2H1V14Z" stroke="currentColor"/><rect x="3" y="4" width="4" height="8" fill="currentColor" fill-opacity="0.5"/><rect x="9" y="4" width="4" height="8" fill="currentColor" fill-opacity="0.5"/>`,
  },
  unified: {
    viewBox: "0 0 16 16",
    body: `<path d="M3.00001 4.00045L12.9998 4L13 6.99955L3 7L3.00001 4.00045Z" fill="currentColor" fill-opacity="0.5"/><path d="M3.0001 9H13L12.9999 12H3L3.0001 9Z" fill="currentColor" fill-opacity="0.5"/><path d="M1 14H15L15 2H1V14Z" stroke="currentColor"/>`,
  },
  review: {
    viewBox: "0 0 20 20",
    body: `<path d="M7 14.5H13M7 7.99512H10.0049M10.0049 7.99512H13M10.0049 7.99512V5M10.0049 7.99512V11M18 18V2L2 2L2 18H18Z" stroke="currentColor"/>`,
  },
  "outline-sliders": {
    viewBox: "0 0 16 16",
    body: `<path d="M11.7779 4.66675H14.4446M11.7779 4.66675C11.7779 5.77132 10.8825 6.66675 9.77789 6.66675C8.67332 6.66675 7.77789 5.77132 7.77789 4.66675M11.7779 4.66675C11.7779 3.56218 10.8825 2.66675 9.77789 2.66675C8.67332 2.66675 7.77789 3.56218 7.77789 4.66675M1.55566 4.66675H7.77789M4.22233 11.3334H1.55566M4.22233 11.3334C4.22233 12.438 5.11776 13.3334 6.22233 13.3334C7.3269 13.3334 8.22233 12.438 8.22233 11.3334M4.22233 11.3334C4.22233 10.2288 5.11776 9.33341 6.22233 9.33341C7.3269 9.33341 8.22233 10.2288 8.22233 11.3334M14.4446 11.3334H8.22233" stroke="currentColor"/>`,
  },
  "outline-copy": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z" stroke="currentColor"/>`,
  },
  "outline-square-arrow": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5555 6.66656V2.44434H9.33326M13.5555 2.44434L7.99993 7.99989M13.5555 9.33324V13.5555C13.5555 13.5555 12.7599 13.5555 11.7777 13.5555H2.44438C2.44438 13.5555 2.44438 12.7599 2.44438 11.7777V4.22213C2.44438 3.2399 2.44434 2.44435 2.44434 2.44435H6.66661" stroke="currentColor"/>`,
  },
  "outline-share": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5554 10.4445V13.5556C13.5554 13.5556 12.7599 13.5556 11.7777 13.5556H4.22211C3.23989 13.5556 2.44434 13.5556 2.44434 13.5556V10.4445M4.88878 5.55557L7.99989 2.44446L11.111 5.55557M7.99989 2.44446L7.99989 9.11112" stroke="currentColor"/>`,
  },
  reset: {
    viewBox: "0 0 20 20",
    body: `<path d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "outline-reset": {
    viewBox: "0 0 20 20",
    body: `<path d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10" stroke="currentColor" stroke-linecap="square"/>`,
  },
  archive: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.1112 13.5555V14.0555H13.6112V13.5555H13.1112ZM2.889 13.5555H2.389L2.389 14.0555H2.889V13.5555ZM3.38901 5.55546L3.38901 5.05546L2.38901 5.05546L2.38901 5.55546L2.88901 5.55546L3.38901 5.55546ZM14.4446 2.44434H14.9446V1.94434L14.4446 1.94434L14.4446 2.44434ZM14.4446 5.55545L14.4446 6.05545L14.9446 6.05545V5.55545H14.4446ZM1.55566 5.55546L1.05566 5.55545L1.05566 6.05546L1.55566 6.05546L1.55566 5.55546ZM1.5557 2.44436L1.5557 1.94436L1.05571 1.94436L1.0557 2.44435L1.5557 2.44436ZM13.1112 5.55546H12.6112V13.5555H13.1112H13.6112V5.55546H13.1112ZM2.889 13.5555H3.389L3.38901 5.55546L2.88901 5.55546L2.38901 5.55546L2.389 13.5555H2.889ZM14.4446 2.44434H13.9446V5.55545H14.4446H14.9446V2.44434H14.4446ZM1.55566 5.55546L2.05566 5.55547L2.0557 2.44436L1.5557 2.44436L1.0557 2.44435L1.05566 5.55545L1.55566 5.55546ZM6.22234 8.22213V8.72213H9.7779V8.22213V7.72213H6.22234V8.22213ZM13.1112 13.5555V13.0555H2.889V13.5555V14.0555H13.1112V13.5555ZM1.5557 2.44436L1.5557 2.94436L14.4446 2.94434L14.4446 2.44434L14.4446 1.94434L1.5557 1.94436L1.5557 2.44436ZM14.4446 5.55545L14.4446 5.05545L1.55566 5.05546L1.55566 5.55546L1.55566 6.05546L14.4446 6.05545L14.4446 5.55545Z" fill="currentColor"/>`,
  },
  // Stop / pause / play — session-tab execution controls. Non-directional
  // media glyphs: never mirrored for RTL (rtl-aware-development skill).
  stop: {
    viewBox: "0 0 16 16",
    body: `<path d="M4.75 4.75H11.25V11.25H4.75V4.75Z" fill="currentColor"/>`,
  },
  pause: {
    viewBox: "0 0 16 16",
    body: `<path d="M5.5 4.5V11.5H7V4.5H5.5Z" fill="currentColor"/><path d="M9 4.5V11.5H10.5V4.5H9Z" fill="currentColor"/>`,
  },
  play: {
    viewBox: "0 0 16 16",
    body: `<path d="M6 4.75L11.25 8L6 11.25V4.75Z" fill="currentColor"/>`,
  },
  star: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1.83334L9.90983 6.09462L14.5595 6.60081L11.0797 9.73472L12.0206 14.3325L8 12.0333L3.97937 14.3325L4.9203 9.73472L1.44047 6.60081L6.09017 6.09462L8 1.83334Z" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "star-filled": {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1.83334L9.90983 6.09462L14.5595 6.60081L11.0797 9.73472L12.0206 14.3325L8 12.0333L3.97937 14.3325L4.9203 9.73472L1.44047 6.60081L6.09017 6.09462L8 1.83334Z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  shield: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1.5L13.5 3.66667V7.44444C13.5 10.8222 11.1852 13.0556 8 14.5C4.81481 13.0556 2.5 10.8222 2.5 7.44444V3.66667L8 1.5Z" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "shield-check": {
    viewBox: "0 0 16 16",
    body: `<path d="M8 1.5L13.5 3.66667V7.44444C13.5 10.8222 11.1852 13.0556 8 14.5C4.81481 13.0556 2.5 10.8222 2.5 7.44444V3.66667L8 1.5Z" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-linejoin="round"/><path d="M5.75 8.25L7.25 9.75L10.25 6.25" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  hourglass: {
    viewBox: "0 0 16 16",
    body: `<path d="M4.5 2.5H11.5L8.5 6.5L11.5 13.5H4.5L7.5 6.5Z" stroke="currentColor" stroke-linejoin="round"/><path d="M4.5 2.5H11.5" stroke="currentColor" stroke-linecap="square"/><path d="M4.5 13.5H11.5" stroke="currentColor" stroke-linecap="square"/>`,
  },
  warning: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" stroke-linejoin="round"/><path d="M8 6.5V9.25" stroke="currentColor" stroke-linecap="round"/><circle cx="8" cy="11.25" r="0.75" fill="currentColor"/>`,
  },
  cache: {
    viewBox: "0 0 16 16",
    body: `<path d="M4 4.5C4 4.5 4 3 8 3C12 3 12 4.5 12 4.5V11.5C12 11.5 12 13 8 13C4 13 4 11.5 4 11.5V4.5Z" stroke="currentColor" stroke-linejoin="round"/><path d="M4 4.5C4 5.5 5.5 6.5 8 6.5C10.5 6.5 12 5.5 12 4.5" stroke="currentColor"/><path d="M4 8C4 9 5.5 10 8 10C10.5 10 12 9 12 8" stroke="currentColor" opacity="0.7"/>`,
  },
  layers: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2L14 5L8 8L2 5Z" stroke="currentColor" stroke-linejoin="round"/><path d="M2 8L8 11L14 8" stroke="currentColor" stroke-linejoin="round"/><path d="M2 11L8 14L14 11" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  chats: {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 3.5C1.8 3.5 1.2 3.9 1.2 4.4V9C1.2 9.5 2 10 2.8 10H6L7.5 11.5L9 10H13.2C14 10 14.8 9.5 14.8 9V4.4C14.8 3.9 14 3.5 13.2 3.5H2.5Z" stroke="currentColor" stroke-linejoin="round"/><path d="M2.5 11.5C1.8 11.5 1.2 11.9 1.2 12.4V13.5C1.2 13.9 1.6 14.2 2.1 14.2H5.5L6.5 13H8.5L9.5 14.2H11.9C12.4 14.2 12.8 13.9 12.8 13.5V12.4C12.8 11.9 12.2 11.5 11.5 11.5H2.5Z" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  clock: {
    viewBox: "0 0 16 16",
    body: `<circle cx="8" cy="8" r="5.75" stroke="currentColor"/><path d="M8 5.2V8L10.8 9.6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  history: {
    viewBox: "0 0 16 16",
    body: `<circle cx="8" cy="8" r="5.75" stroke="currentColor"/><path d="M8 5.2V8L10.8 9.6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 8C3.2 5.35 5.35 3.2 8 3.2" stroke="currentColor" stroke-linecap="round" opacity="0.85"/>`,
  },
};

const spriteID = "opencode-v2-icon-sprite"
const symbol = (name: keyof typeof icons) => `opencode-v2-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(icons)
    .map(
      ([name, icon]) =>
        `<symbol id="${symbol(name as keyof typeof icons)}" viewBox="${icon.viewBox}">${icon.body}</symbol>`,
    )
    .join("")
  document.body.insertBefore(svg, document.body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = () => (icons[split.name as keyof typeof icons] ? (split.name as keyof typeof icons) : "plus")
  const icon = () => icons[iconName()]
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      width={pixelSize}
      height={pixelSize}
      viewBox={icon().viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <use href={`#${symbol(iconName())}`} />
    </svg>
  )
}
