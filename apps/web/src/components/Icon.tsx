/** Proste ikony liniowe (inline SVG, bez zewnętrznych zasobów). */
const PATHS: Record<string, string> = {
  chat: 'M4 5h16v10H9l-5 4z',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  memory: 'M6 4h12v16l-6-4-6 4z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  settings:
    'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2-6z',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  users:
    'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 010 6M21 20c0-2.5-1.5-4.2-4-4.8',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  share: 'M12 4v11M8 8l4-4 4 4M5 14v6h14v-6',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0',
  device: 'M4 5h16v11H4zM9 20h6M12 16v4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  mic: 'M12 4a3 3 0 00-3 3v5a3 3 0 006 0V7a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v3',
  speaker: 'M5 9h3l4-4v14l-4-4H5zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  download: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  upload: 'M12 16V5M8 9l4-4 4 4M5 20h14',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  search: 'M11 5a6 6 0 100 12 6 6 0 000-12zM20 20l-4.3-4.3',
  back: 'M15 5l-7 7 7 7',
};

export function Icon({
  name,
  size = 18,
  label,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
