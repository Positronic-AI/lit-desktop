// Knowledge-graph panel — a WebGL force-directed graph, ported from the webapp's
// knowledge-graph-widget (buildScene / forceLayout / processData), minus the
// fly-around + combat easter egg. Master/detail: click a node → its messages,
// with a Back button (same model as the calendar).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fetchKnowledgeGraph, type GraphNode, type GraphEdge } from "./api";

const TYPE_COLORS: Record<string, number> = {
  concepts: 0x7aa2f7, products: 0xf7768e, people: 0x9ece6a, patents: 0xe0af68,
  "file:": 0xbb9af7, tickets: 0xff9e64, channels: 0x73daca, backlog: 0xffc777,
  deferred: 0xffc777, other: 0x565f89,
};
const PROXIMITY_RADIUS = 30;

export interface GraphContext {
  channelId: string;
  jumpToMessage: (id?: string) => void;
  escapeHtml: (s: string) => string;
}

function processData(data: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of data.nodes) {
    if (n.id === "file:...") continue;
    const label = (n.id.split("/").pop() || n.id).replace(/-/g, " ");
    if (seen.has(label)) continue;
    seen.add(label);
    nodes.push({ ...n, label });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  return { nodes, edges };
}

function forceLayout(nodes: GraphNode[], edges: GraphEdge[], nodeMap: Record<string, number>): THREE.Vector3[] {
  const positions = nodes.map(() => {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r = 25 + Math.random() * 15;
    return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
  });
  const velocities = nodes.map(() => new THREE.Vector3());
  const iterations = 300;
  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const diff = positions[i].clone().sub(positions[j]);
        const dist = Math.max(diff.length(), 0.5);
        const force = diff.normalize().multiplyScalar(800 / (dist * dist));
        velocities[i].add(force);
        velocities[j].sub(force);
      }
    }
    for (const e of edges) {
      const si = nodeMap[e.source], ti = nodeMap[e.target];
      if (si === undefined || ti === undefined) continue;
      const diff = positions[ti].clone().sub(positions[si]);
      const dist = diff.length();
      const force = diff.normalize().multiplyScalar(dist * 0.02 * (e.weight || 1));
      velocities[si].add(force);
      velocities[ti].sub(force);
    }
    for (let i = 0; i < nodes.length; i++) {
      velocities[i].sub(positions[i].clone().multiplyScalar(0.01));
      if (velocities[i].length() > 10) velocities[i].normalize().multiplyScalar(10);
      positions[i].add(velocities[i].clone().multiplyScalar(0.3 * cooling));
      velocities[i].multiplyScalar(0.5);
    }
  }
  for (const pos of positions) if (pos.length() > 80) pos.normalize().multiplyScalar(80);
  return positions;
}

/** Mount the graph into `host`. Returns a dispose fn. */
export function mountGraphView(host: HTMLElement, ctx: GraphContext): () => void {
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  host.innerHTML = `
    <div class="kg-view">
      <canvas class="kg-canvas"></canvas>
      <div class="kg-legend"></div>
      <div class="kg-tooltip" hidden></div>
      <div class="kg-hint">drag to rotate · scroll to zoom · click a node</div>
      <div class="kg-status">Loading graph…</div>
    </div>
    <div class="kg-results" hidden>
      <div class="cal-results-head"><button class="kg-back" type="button">&#8249; Back</button><span class="kg-results-title"></span></div>
      <div class="kg-msg-list"></div>
    </div>`;
  const graphView = host.querySelector(".kg-view") as HTMLElement;
  const resultsView = host.querySelector(".kg-results") as HTMLElement;
  const canvas = host.querySelector(".kg-canvas") as HTMLCanvasElement;
  const legendEl = host.querySelector(".kg-legend") as HTMLElement;
  const tooltipEl = host.querySelector(".kg-tooltip") as HTMLElement;
  const statusEl = host.querySelector(".kg-status") as HTMLElement;
  const resultsTitle = host.querySelector(".kg-results-title") as HTMLElement;
  const msgList = host.querySelector(".kg-msg-list") as HTMLElement;

  let animId = 0;
  let disposed = false;
  let renderer: THREE.WebGLRenderer | null = null;
  let controls: OrbitControls | null = null;
  let resizeObs: ResizeObserver | null = null;
  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

  const showNode = (node: GraphNode) => {
    resultsTitle.textContent = `${node.label || node.id} · ${node.messages.length} message${node.messages.length === 1 ? "" : "s"}`;
    msgList.scrollTop = 0;
    msgList.innerHTML = node.messages.map((m) =>
      `<div class="kg-msg" data-id="${ctx.escapeHtml(m.message_id || "")}">` +
        `<div class="kg-msg-ref">${ctx.escapeHtml(m.ref.split("/")[1] || "")}</div>` +
        `<div class="kg-msg-excerpt">${ctx.escapeHtml(m.excerpt || "")}</div></div>`,
    ).join("") || `<div class="search-status">No messages.</div>`;
    msgList.querySelectorAll(".kg-msg").forEach((r) =>
      r.addEventListener("click", () => ctx.jumpToMessage((r as HTMLElement).dataset.id)));
    graphView.hidden = true;
    resultsView.hidden = false;
    if (controls) controls.autoRotate = false;
  };
  (host.querySelector(".kg-back") as HTMLElement).addEventListener("click", () => {
    resultsView.hidden = true;
    graphView.hidden = false;
    if (controls) controls.autoRotate = true;
  });

  fetchKnowledgeGraph(ctx.channelId).then((raw) => {
    if (disposed) return;
    const { nodes, edges } = processData(raw);
    if (!nodes.length) { statusEl.textContent = "No graph data for this channel yet."; return; }
    statusEl.remove();
    buildScene(nodes, edges);
  }).catch(() => { statusEl.textContent = "Failed to load graph."; });

  function buildScene(nodes: GraphNode[], edges: GraphEdge[]) {
    const width = graphView.clientWidth || 400;
    const height = graphView.clientHeight || 400;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;

    const nodeMap: Record<string, number> = {};
    nodes.forEach((n, i) => (nodeMap[n.id] = i));
    const positions = forceLayout(nodes, edges, nodeMap);

    const maxR = positions.reduce((r, p) => Math.max(r, p.length()), 0);
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    camera.position.set(0, 0, (maxR / Math.sin(Math.min(vFov, hFov) / 2)) * 1.15);

    const nodeMeshes: THREE.Mesh[] = [];
    const glowMeshes: THREE.Mesh[] = [];
    const labelSprites: THREE.Sprite[] = [];
    const nodeGroup = new THREE.Group();
    nodes.forEach((n, i) => {
      const size = 0.6 + Math.sqrt(n.count) * 0.6;
      const color = TYPE_COLORS[n.type] || TYPE_COLORS.other;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(size, 24, 24),
        new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.3, transparent: true, opacity: 0.9 }),
      );
      mesh.position.copy(positions[i]);
      (mesh.userData as { node: GraphNode }).node = n;
      nodeGroup.add(mesh);
      nodeMeshes.push(mesh);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(size * 1.8, 16, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08 }),
      );
      glow.position.copy(positions[i]);
      nodeGroup.add(glow);
      glowMeshes.push(glow);
    });
    scene.add(nodeGroup);

    const edgeColor = isDark ? 0x3d4f7a : 0xb0b8d0;
    const edgeGroup = new THREE.Group();
    const edgeRecords: Array<{ line: THREE.Line; sType: string; tType: string }> = [];
    edges.forEach((e) => {
      const si = nodeMap[e.source], ti = nodeMap[e.target];
      if (si === undefined || ti === undefined) return;
      const geo = new THREE.BufferGeometry().setFromPoints([positions[si], positions[ti]]);
      const opacity = Math.min(0.15 + e.weight * 0.08, 0.5);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity }));
      edgeGroup.add(line);
      edgeRecords.push({ line, sType: nodes[si].type, tType: nodes[ti].type });
    });
    scene.add(edgeGroup);

    const labelColor = isDark ? "#c0caf5" : "#1a1a2e";
    const labelGroup = new THREE.Group();
    nodes.forEach((n, i) => {
      const cnv = document.createElement("canvas");
      const c2d = cnv.getContext("2d")!;
      const fontSize = 28;
      const text = n.label || n.id;
      c2d.font = `${fontSize}px sans-serif`;
      const tw = c2d.measureText(text).width + 20;
      cnv.width = tw;
      cnv.height = fontSize + 12;
      c2d.font = `${fontSize}px sans-serif`;
      c2d.fillStyle = labelColor;
      c2d.textBaseline = "middle";
      c2d.fillText(text, 10, cnv.height / 2);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cnv), transparent: true, opacity: 0.85 }));
      const size = 0.6 + Math.sqrt(n.count) * 0.6;
      sprite.position.copy(positions[i]).add(new THREE.Vector3(0, size + 1.5, 0));
      sprite.scale.set(tw / 40, (fontSize + 12) / 40, 1);
      labelGroup.add(sprite);
      labelSprites.push(sprite);
    });
    scene.add(labelGroup);

    scene.add(new THREE.AmbientLight(isDark ? 0x404060 : 0xd0d0e0, isDark ? 0.5 : 0.8));
    const dir = new THREE.DirectionalLight(0x7aa2f7, isDark ? 0.8 : 0.5);
    dir.position.set(50, 50, 50);
    scene.add(dir);
    const pt = new THREE.PointLight(0xf7768e, isDark ? 0.4 : 0.25, 200);
    pt.position.set(-30, -30, 30);
    scene.add(pt);

    // Type-filter legend — click a type to toggle its nodes (and their edges).
    const activeTypes = new Set(nodes.map((n) => n.type));
    const typeCounts: Record<string, number> = {};
    nodes.forEach((n) => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
    const applyFilter = () => {
      nodes.forEach((n, i) => {
        const on = activeTypes.has(n.type);
        nodeMeshes[i].visible = on;
        glowMeshes[i].visible = on;
        labelSprites[i].visible = on;
      });
      edgeRecords.forEach((er) => { er.line.visible = activeTypes.has(er.sType) && activeTypes.has(er.tType); });
    };
    legendEl.innerHTML = Object.keys(typeCounts).sort().map((type) => {
      const hex = `#${(TYPE_COLORS[type] || TYPE_COLORS.other).toString(16).padStart(6, "0")}`;
      return `<button class="kg-legend-item" data-type="${type}" type="button">` +
        `<span class="kg-swatch" style="background:${hex}"></span>${type}` +
        `<span class="kg-legend-count">${typeCounts[type]}</span></button>`;
    }).join("");
    legendEl.querySelectorAll(".kg-legend-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = (btn as HTMLElement).dataset.type!;
        if (activeTypes.has(type)) { activeTypes.delete(type); btn.classList.add("off"); }
        else { activeTypes.add(type); btn.classList.remove("off"); }
        applyFilter();
      });
    });

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const setMouse = (ev: MouseEvent) => {
      const rect = renderer!.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };
    const onClick = (ev: MouseEvent) => {
      setMouse(ev);
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(nodeMeshes.filter((m) => m.visible));
      if (hits.length) showNode((hits[0].object.userData as { node: GraphNode }).node);
    };
    let hovered: THREE.Mesh | null = null;
    const onMove = (ev: MouseEvent) => {
      setMouse(ev);
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(nodeMeshes.filter((m) => m.visible));
      if (hovered) (hovered.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.3;
      if (hits.length) {
        hovered = hits[0].object as THREE.Mesh;
        (hovered.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.8;
        renderer!.domElement.style.cursor = "pointer";
        const node = (hovered.userData as { node: GraphNode }).node;
        const rect = graphView.getBoundingClientRect();
        tooltipEl.textContent = `${node.label || node.id} · ${node.count} msg${node.count === 1 ? "" : "s"}`;
        tooltipEl.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 140)}px`;
        tooltipEl.style.top = `${ev.clientY - rect.top - 8}px`;
        tooltipEl.hidden = false;
      } else {
        hovered = null;
        renderer!.domElement.style.cursor = "default";
        tooltipEl.hidden = true;
      }
    };
    const addL = (t: EventTarget, ev: string, fn: EventListenerOrEventListenerObject) => {
      t.addEventListener(ev, fn);
      listeners.push([t, ev, fn]);
    };
    addL(renderer.domElement, "click", onClick as EventListener);
    addL(renderer.domElement, "mousemove", onMove as EventListener);

    resizeObs = new ResizeObserver(() => {
      const w = graphView.clientWidth, h = graphView.clientHeight;
      if (w && h && renderer) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    });
    resizeObs.observe(graphView);

    const animate = () => {
      if (disposed) return;
      animId = requestAnimationFrame(animate);
      const t = Date.now() * 0.001;
      controls!.update();
      const camPos = camera.position;
      nodeMeshes.forEach((m, i) => {
        const prox = Math.max(0, 1 - camPos.distanceTo(m.position) / PROXIMITY_RADIUS);
        m.scale.setScalar(1 + Math.sin(t * 0.5 + i) * 0.03 + prox * 0.3);
        (m.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.3 + prox * 0.7;
        if (glowMeshes[i]) {
          (glowMeshes[i].material as THREE.MeshBasicMaterial).opacity = 0.08 + prox * 0.25;
          glowMeshes[i].scale.setScalar(1 + prox * 0.5);
        }
        if (labelSprites[i]) (labelSprites[i].material as THREE.SpriteMaterial).opacity = 0.4 + prox * 0.6;
      });
      renderer!.render(scene, camera);
    };
    animate();
  }

  return () => {
    disposed = true;
    if (animId) cancelAnimationFrame(animId);
    listeners.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn));
    resizeObs?.disconnect();
    controls?.dispose();
    renderer?.dispose();
  };
}
