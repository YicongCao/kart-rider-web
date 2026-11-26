import { Box3, Mesh, Triangle, Vector3 } from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import roadRanges from "./road-mesh-ranges.json" with { type: "json" };

export interface TrackWallContact {
  normalX: number;
  normalZ: number;
  depth: number;
}

interface Face {
  triangle: Triangle;
  normal: Vector3;
  minY: number;
  maxY: number;
  lastQuery: number;
}

interface Cell {
  ground: Face[];
  walls: Face[];
}

const CELL_SIZE = 4;
const FLOOR_NORMAL_Y = 0.65;
const cellAt = (coordinate: number) => Math.floor(coordinate / CELL_SIZE);

// [first index, index count] recovers the .1s Road* nodes and their separate
// bridge, roadway, fence and handrail surfaces from material-batched glTFs.
const tracks: Record<string, Record<string, number[][]>> = roadRanges;

export class TrackCollision {
  private readonly columns = new Map<number, Map<number, Cell>>();
  private readonly localTriangle = new Triangle();
  private readonly localBox = new Box3();
  private queryId = 0;

  constructor(gltf: GLTF, trackId: string) {
    const rangesByMesh = tracks[trackId];
    if (!rangesByMesh) throw new Error(`赛道缺少碰撞网格 ${trackId}`);
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((mesh) => {
      if (!(mesh instanceof Mesh)) return;
      const meshId = gltf.parser.associations.get(mesh)?.meshes;
      if (meshId === undefined) return;
      const ranges = rangesByMesh[meshId] ?? [];
      // Some course tiles are separate scene nodes (e.g. the landing on
      // ice). Their undersides and front skirts are scenery below the road.
      const extraGround = /road/i.test(mesh.material.name);
      if (!ranges.length && !extraGround) return;
      const positions = mesh.geometry.getAttribute("position");
      const indices = mesh.geometry.index;
      const vertex = (i: number) => new Vector3()
        .fromBufferAttribute(positions, indices ? indices.getX(i) : i)
        .applyMatrix4(mesh.matrixWorld);
      const count = indices?.count ?? positions.count;
      let rangeIndex = 0;
      for (let i = 0; i < count; i += 3) {
        const range = ranges[rangeIndex];
        const fromRoadMesh = range && i >= range[0];
        if (fromRoadMesh || extraGround) {
          this.addFace(new Triangle(vertex(i), vertex(i + 1), vertex(i + 2)), !fromRoadMesh);
        }
        if (range && i + 3 >= range[0] + range[1]) rangeIndex++;
      }
    });
  }

  private addFace(triangle: Triangle, groundOnly: boolean) {
    const { a, b, c } = triangle;
    const normal = triangle.getNormal(new Vector3());
    if (normal.lengthSq() < 0.5 || (groundOnly && Math.abs(normal.y) < FLOOR_NORMAL_Y)) return;
    const face: Face = {
      triangle, normal, lastQuery: 0,
      minY: Math.min(a.y, b.y, c.y),
      maxY: Math.max(a.y, b.y, c.y),
    };
    const group = Math.abs(normal.y) >= FLOOR_NORMAL_Y ? "ground" : "walls";
    const minX = cellAt(Math.min(a.x, b.x, c.x));
    const maxX = cellAt(Math.max(a.x, b.x, c.x));
    const minZ = cellAt(Math.min(a.z, b.z, c.z));
    const maxZ = cellAt(Math.max(a.z, b.z, c.z));
    for (let x = minX; x <= maxX; x++) {
      let column = this.columns.get(x);
      if (!column) this.columns.set(x, column = new Map());
      for (let z = minZ; z <= maxZ; z++) {
        let cell = column.get(z);
        if (!cell) column.set(z, cell = { ground: [], walls: [] });
        cell[group].push(face);
      }
    }
  }

  /** Select the deck closest to the kart's current height at crossings. */
  groundHeight(x: number, y: number, z: number, ceiling = Infinity): number | null {
    const cell = this.columns.get(cellAt(x))?.get(cellAt(z));
    if (!cell) return null;
    let height: number | null = null;
    let nearest = 4;
    for (const { triangle: { a, b, c }, normal, minY, maxY } of cell.ground) {
      if (minY > Math.min(y + nearest, ceiling) || maxY < y - nearest) continue;
      const ab = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
      const bc = (c.x - b.x) * (z - b.z) - (c.z - b.z) * (x - b.x);
      const ca = (a.x - c.x) * (z - c.z) - (a.z - c.z) * (x - c.x);
      if (Math.min(ab, bc, ca) < -1e-7 && Math.max(ab, bc, ca) > 1e-7) continue;
      const surfaceY = a.y - (normal.x * (x - a.x) + normal.z * (z - a.z)) / normal.y;
      const delta = Math.abs(surfaceY - y);
      if (surfaceY <= ceiling && delta < nearest) {
        height = surfaceY;
        nearest = delta;
      }
    }
    return height;
  }

  queryWall(
    x: number, y: number, z: number, yaw: number, halfWidth: number, halfLength: number,
  ): TrackWallContact | null {
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const spanX = Math.abs(forwardZ) * halfWidth + Math.abs(forwardX) * halfLength;
    const spanZ = Math.abs(forwardX) * halfWidth + Math.abs(forwardZ) * halfLength;
    // y is the wheel contact height. The chassis clears low curb lips.
    const centerY = y + 0.52;
    const halfHeight = 0.38;
    this.localBox.min.set(-halfWidth, -halfHeight, -halfLength);
    this.localBox.max.set(halfWidth, halfHeight, halfLength);
    const local = (world: Vector3, target: Vector3) => {
      const dx = world.x - x;
      const dz = world.z - z;
      target.set(dx * forwardZ - dz * forwardX, world.y - centerY, dx * forwardX + dz * forwardZ);
    };
    const queryId = ++this.queryId;
    let best: TrackWallContact | null = null;
    for (let cx = cellAt(x - spanX); cx <= cellAt(x + spanX); cx++) {
      const column = this.columns.get(cx);
      if (!column) continue;
      for (let cz = cellAt(z - spanZ); cz <= cellAt(z + spanZ); cz++) {
        const cell = column.get(cz);
        if (!cell) continue;
        for (const face of cell.walls) {
          if (face.lastQuery === queryId) continue;
          face.lastQuery = queryId;
          if (face.minY > centerY + halfHeight || face.maxY < centerY - halfHeight) continue;
          const { triangle: { a, b, c }, normal } = face;
          local(a, this.localTriangle.a);
          local(b, this.localTriangle.b);
          local(c, this.localTriangle.c);
          if (!this.localBox.intersectsTriangle(this.localTriangle)) continue;
          const sideways = normal.x * forwardZ - normal.z * forwardX;
          const forward = normal.x * forwardX + normal.z * forwardZ;
          const radius = Math.abs(sideways) * halfWidth + Math.abs(forward) * halfLength
            + Math.abs(normal.y) * halfHeight;
          const distance = normal.x * (x - a.x) + normal.y * (centerY - a.y) + normal.z * (z - a.z);
          const horizontal = Math.hypot(normal.x, normal.z);
          const depth = (radius - Math.abs(distance)) / horizontal;
          if (depth <= (best?.depth ?? 0)) continue;
          const sign = distance < 0 ? -1 : 1;
          best = { normalX: sign * normal.x / horizontal, normalZ: sign * normal.z / horizontal, depth };
        }
      }
    }
    return best;
  }
}
