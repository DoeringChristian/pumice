import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { MetadataIndexApi, VaultPath } from '@pumice/api';

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  /** Notes are files; tags and unresolved targets are virtual. */
  kind: 'note' | 'attachment' | 'tag' | 'unresolved';
  path?: VaultPath;
  degree: number;
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: GraphNode | string;
  target: GraphNode | string;
}

export interface GraphOptions {
  /** Restrict to notes within `depth` links of this path (local graph). */
  center?: VaultPath;
  depth: number;
  showOrphans: boolean;
  showAttachments: boolean;
  showTags: boolean;
  showUnresolved: boolean;
  filter: string;
}

const isNote = (path: string) => /\.(md|excalidraw)$/i.test(path);

/** Builds the node/link lists from the index. */
export function buildGraph(
  index: MetadataIndexApi,
  opts: GraphOptions,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const add = (node: Omit<GraphNode, 'degree'>) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { ...node, degree: 0 });
    return nodes.get(node.id)!;
  };
  for (const file of index.files()) {
    const note = isNote(file.path);
    if (!note && !opts.showAttachments) continue;
    add({ id: file.path, label: file.title, kind: note ? 'note' : 'attachment', path: file.path });
  }
  for (const file of index.files()) {
    if (!nodes.has(file.path)) continue;
    const seen = new Set<string>();
    for (const r of index.outgoing(file.path)) {
      let target: string | undefined = r.target;
      if (!target) {
        if (!opts.showUnresolved || !r.link.target) continue;
        target = `unresolved:${r.link.target.toLowerCase()}`;
        add({ id: target, label: r.link.target, kind: 'unresolved' });
      }
      if (!nodes.has(target) || target === file.path || seen.has(target)) continue;
      seen.add(target);
      links.push({ source: file.path, target });
    }
    if (opts.showTags) {
      for (const { tag } of file.meta?.tags ?? []) {
        const id = `tag:${tag.toLowerCase()}`;
        add({ id, label: `#${tag}`, kind: 'tag' });
        if (!seen.has(id)) {
          seen.add(id);
          links.push({ source: file.path, target: id });
        }
      }
    }
  }

  let keep: Set<string> | undefined;
  if (opts.center && nodes.has(opts.center)) {
    // Breadth-first over links in both directions.
    const adjacency = new Map<string, string[]>();
    for (const l of links) {
      const s = l.source as string;
      const t = l.target as string;
      adjacency.set(s, [...(adjacency.get(s) ?? []), t]);
      adjacency.set(t, [...(adjacency.get(t) ?? []), s]);
    }
    keep = new Set([opts.center]);
    let frontier = [opts.center];
    for (let d = 0; d < opts.depth; d++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const n of adjacency.get(id) ?? []) if (!keep.has(n)) (keep.add(n), next.push(n));
      frontier = next;
    }
  }
  const q = opts.filter.trim().toLowerCase();
  const visible = [...nodes.values()].filter(
    (n) =>
      (!keep || keep.has(n.id)) &&
      (!q || n.label.toLowerCase().includes(q) || n.path?.toLowerCase().includes(q)),
  );
  const ids = new Set(visible.map((n) => n.id));
  const visibleLinks = links.filter(
    (l) => ids.has(l.source as string) && ids.has(l.target as string),
  );
  for (const l of visibleLinks) {
    nodes.get(l.source as string)!.degree++;
    nodes.get(l.target as string)!.degree++;
  }
  const result = opts.showOrphans || keep ? visible : visible.filter((n) => n.degree > 0);
  return { nodes: result, links: visibleLinks };
}

interface Colors {
  note: string;
  attachment: string;
  tag: string;
  unresolved: string;
  active: string;
  link: string;
  linkHighlight: string;
  label: string;
  background: string;
}

function readColors(el: HTMLElement): Colors {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    note: v('--text-muted', '#888'),
    attachment: v('--text-faint', '#aaa'),
    tag: '#4c9a5c',
    unresolved: v('--text-faint', '#bbb'),
    active: v('--accent', '#c8582e'),
    link: v('--border', '#ddd'),
    linkHighlight: v('--accent', '#c8582e'),
    label: v('--text', '#333'),
    background: v('--bg', '#fff'),
  };
}

/** Canvas renderer with pan, zoom, drag and hover highlighting. */
export class GraphCanvas {
  readonly canvas = document.createElement('canvas');
  private readonly ctx2d: CanvasRenderingContext2D;
  private sim: Simulation<GraphNode, GraphLink> | undefined;
  private nodes: GraphNode[] = [];
  private links: GraphLink[] = [];
  private neighbors = new Map<string, Set<string>>();
  private transform = { x: 0, y: 0, k: 1 };
  private hover: GraphNode | undefined;
  private dragging: GraphNode | undefined;
  private panning: { x: number; y: number; tx: number; ty: number } | undefined;
  private moved = false;
  /** Until the user pans or zooms, the view keeps fitting the whole graph. */
  private userMoved = false;
  private frame = 0;
  private colors: Colors;
  active: string | undefined;
  private readonly resize: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly onOpen: (node: GraphNode, newTab: boolean) => void,
  ) {
    this.canvas.className = 'pm-graph-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Graph of notes and links');
    host.append(this.canvas);
    this.ctx2d = this.canvas.getContext('2d')!;
    this.colors = readColors(host);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.bindEvents();
  }

  setData(nodes: GraphNode[], links: GraphLink[]): void {
    // Keep positions of nodes that stay.
    const previous = new Map(this.nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const p = previous.get(n.id);
      if (p) Object.assign(n, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
    }
    this.nodes = nodes;
    this.links = links;
    this.neighbors = new Map(nodes.map((n) => [n.id, new Set<string>()]));
    for (const l of links) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      this.neighbors.get(s)?.add(t);
      this.neighbors.get(t)?.add(s);
    }
    this.sim?.stop();
    this.sim = forceSimulation<GraphNode, GraphLink>(nodes)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(links)
          .id((n) => n.id)
          .distance(90)
          .strength(0.5),
      )
      .force('charge', forceManyBody<GraphNode>().strength(-300).distanceMax(600))
      .force('center', forceCenter(0, 0))
      .force('x', forceX<GraphNode>(0).strength(0.04))
      .force('y', forceY<GraphNode>(0).strength(0.04))
      .force(
        'collide',
        forceCollide<GraphNode>((n) => this.radius(n) + 2),
      )
      .alpha(previous.size ? 0.3 : 1)
      .on('tick', () => {
        if (!this.userMoved) this.zoomToFit();
        this.draw();
      });
  }

  dispose(): void {
    this.sim?.stop();
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    this.canvas.remove();
  }

  /** Re-reads theme colors (after a theme switch). */
  refreshColors(): void {
    this.colors = readColors(this.host);
    this.draw();
  }

  private radius(n: GraphNode): number {
    return (n.kind === 'note' ? 4 : 3) + Math.sqrt(n.degree) * 1.6;
  }

  private fit(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.host.getBoundingClientRect();
    this.canvas.width = Math.max(1, width * dpr);
    this.canvas.height = Math.max(1, height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    if (this.transform.x === 0 && this.transform.y === 0) {
      this.transform.x = width / 2;
      this.transform.y = height / 2;
    }
    this.draw();
  }

  private zoomToFit(): void {
    if (!this.nodes.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height || minX === Infinity) return;
    const pad = 80;
    const k = Math.min(
      2.5,
      Math.max(
        0.05,
        Math.min(
          (width - pad * 2) / Math.max(1, maxX - minX),
          (height - pad * 2) / Math.max(1, maxY - minY),
        ),
      ),
    );
    this.transform = {
      k,
      x: width / 2 - ((minX + maxX) / 2) * k,
      y: height / 2 - ((minY + maxY) / 2) * k,
    };
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.transform.x) / this.transform.k,
      y: (clientY - rect.top - this.transform.y) / this.transform.k,
    };
  }

  private nodeAt(clientX: number, clientY: number): GraphNode | undefined {
    const p = this.toWorld(clientX, clientY);
    let best: GraphNode | undefined;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
      if (d < this.radius(n) + 4 / this.transform.k && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.moved = false;
      const node = this.nodeAt(e.clientX, e.clientY);
      if (node) {
        this.dragging = node;
        this.sim?.alphaTarget(0.2).restart();
      } else {
        this.panning = { x: e.clientX, y: e.clientY, tx: this.transform.x, ty: this.transform.y };
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const p = this.toWorld(e.clientX, e.clientY);
        this.dragging.fx = p.x;
        this.dragging.fy = p.y;
        this.moved = true;
        return;
      }
      if (this.panning) {
        this.userMoved = true;
        this.transform.x = this.panning.tx + e.clientX - this.panning.x;
        this.transform.y = this.panning.ty + e.clientY - this.panning.y;
        this.moved = true;
        this.draw();
        return;
      }
      const hover = this.nodeAt(e.clientX, e.clientY);
      if (hover !== this.hover) {
        this.hover = hover;
        c.style.cursor = hover ? 'pointer' : 'grab';
        this.draw();
      }
    });
    const end = (e: PointerEvent) => {
      if (this.dragging) {
        if (
          !this.moved &&
          (this.dragging.kind === 'note' ||
            this.dragging.kind === 'attachment' ||
            this.dragging.kind === 'unresolved' ||
            this.dragging.kind === 'tag')
        ) {
          this.onOpen(this.dragging, e.metaKey || e.ctrlKey);
        }
        this.dragging.fx = null;
        this.dragging.fy = null;
        this.dragging = undefined;
        this.sim?.alphaTarget(0);
      }
      this.panning = undefined;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.userMoved = true;
        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = Math.min(8, Math.max(0.05, this.transform.k * Math.exp(-e.deltaY * 0.0015)));
        this.transform.x = mx - ((mx - this.transform.x) * k) / this.transform.k;
        this.transform.y = my - ((my - this.transform.y) * k) / this.transform.k;
        this.transform.k = k;
        this.draw();
      },
      { passive: false },
    );
  }

  draw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  }

  private colorsReady = false;

  private paint(): void {
    // Theme variables only resolve once the canvas is in the document.
    if (!this.colorsReady && this.host.isConnected) {
      this.colors = readColors(this.host);
      this.colorsReady = true;
    }
    const ctx = this.ctx2d;
    const dpr = window.devicePixelRatio || 1;
    const { x, y, k } = this.transform;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    const focus =
      this.hover ?? (this.active ? this.nodes.find((n) => n.id === this.active) : undefined);
    const near = focus ? this.neighbors.get(focus.id) : undefined;

    ctx.lineWidth = 1 / k;
    for (const l of this.links) {
      const s = l.source as GraphNode;
      const t = l.target as GraphNode;
      if (s.x === undefined || t.x === undefined) continue;
      const lit = focus && (s === focus || t === focus);
      ctx.strokeStyle = lit ? this.colors.linkHighlight : this.colors.link;
      ctx.globalAlpha = focus && !lit ? 0.35 : 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y!);
      ctx.lineTo(t.x, t.y!);
      ctx.stroke();
    }
    for (const n of this.nodes) {
      if (n.x === undefined) continue;
      const isFocus = n === focus || n.id === this.active;
      const dim = focus && !isFocus && !near?.has(n.id);
      ctx.globalAlpha = dim ? 0.3 : 1;
      ctx.fillStyle = isFocus ? this.colors.active : this.colors[n.kind];
      ctx.beginPath();
      ctx.arc(n.x, n.y!, this.radius(n), 0, Math.PI * 2);
      ctx.fill();
    }
    // Labels when zoomed in enough, and always for the focused neighbourhood.
    ctx.font = `${12 / k}px ${getComputedStyle(this.host).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of this.nodes) {
      if (n.x === undefined) continue;
      const important = n === focus || near?.has(n.id) || n.id === this.active;
      const small = this.nodes.length <= 80;
      if (!important && !small && k < 1.1) continue;
      ctx.globalAlpha =
        focus && !important ? 0.3 : important || small ? 1 : Math.min(1, (k - 1.1) * 3);
      ctx.fillStyle = this.colors.label;
      ctx.fillText(n.label, n.x, n.y! + this.radius(n) + 3 / k);
    }
    ctx.globalAlpha = 1;
  }
}
