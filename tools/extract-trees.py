"""Tree positions from two aerials: the close one where it reaches, the wide
one for the outer ring. Vegetation is segmented on G-R so the screenshots'
blue colour cast does not matter."""
import json, math, numpy as np
from PIL import Image

SRC = [
    # path, scale px/m, origin px, label
    ('/home/francis/Pictures/Screenshots/Screenshot from 2026-09-12 19-48-34.png', 6.311, 981.0, 736.0, 'close'),
    ('/home/francis/Pictures/Screenshots/Screenshot from 2026-09-12 20-16-15.png', 2.074, 1159.5, 885.4, 'wide'),
]
RADIUS = 200.0

layers = []
for path, scale, ox, oy, label in SRC:
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    h, w, _ = a.shape
    veg = ((a[:,:,1] - a[:,:,0]) > 12) & (a.mean(axis=2) < 158)
    layers.append(dict(veg=veg, scale=scale, ox=ox, oy=oy, w=w, h=h, label=label))
    print(f"{label:>6}: {w}x{h} scale={scale} veg={100*veg.mean():.1f}%  "
          f"covers E{(w-ox)/scale:+.0f} W{-ox/scale:+.0f} N{oy/scale:+.0f} S{-(h-oy)/scale:+.0f} m")

def lookup(e, n):
    """Vegetation at a point, preferring the higher-resolution source."""
    for L in layers:
        x, y = L['ox'] + e*L['scale'], L['oy'] - n*L['scale']
        if 2 <= x < L['w']-2 and 2 <= y < L['h']-2:
            return bool(L['veg'][int(y), int(x)]), L
    return None, None

def density(e, n, metres=7.0):
    for L in layers:
        x, y = L['ox'] + e*L['scale'], L['oy'] - n*L['scale']
        r = max(2, int(metres*L['scale']))
        if r+2 <= x < L['w']-r-2 and r+2 <= y < L['h']-r-2:
            return float(L['veg'][int(y)-r:int(y)+r, int(x)-r:int(x)+r].mean())
    return 0.0

for lbl,(e,n) in {"schoolyard":(30,-30),"Sporthalle":(115,-49),"woodland NW":(-90,60),
                  "far north":(0,185),"far west":(-185,0),"far south":(0,-185)}.items():
    v,L = lookup(e,n)
    print(f"  {lbl:>12}: veg={v} via {L['label'] if L else 'none'}  density={density(e,n)*100:.0f}%")

# --- OSM exclusions -------------------------------------------------------
osm = json.load(open('data/osm-raw.json'))
lat0, lon0 = 52.6023057, 13.1300374
mlat = 111320.0; mlon = 111320.0*math.cos(math.radians(lat0))
proj = lambda p: ((p['lon']-lon0)*mlon, (p['lat']-lat0)*mlat)
blocked, roads = [], []
for el in osm['elements']:
    t = el.get('tags') or {}
    if el.get('type') != 'way': continue
    g = el.get('geometry') or []
    r = [proj(p) for p in g] if len(g) >= 3 else None
    if t.get('building') and r: blocked.append(r)
    elif t.get('leisure') in ('pitch','track') and r: blocked.append(r)
    elif t.get('highway') and g:
        pts = [proj(p) for p in g]
        soft = t['highway'] in ('footway','path','cycleway','track','pedestrian')
        for i in range(len(pts)-1): roads.append((pts[i], pts[i+1], 2.5 if soft else 5.5))

def inside(pt, ring):
    x, y = pt; c = False; n = len(ring)
    for i in range(n):
        j = (i-1) % n
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj-xi)*(y-yi)/(yj-yi) + xi: c = not c
    return c
def near_road(e, n):
    for p, q, d in roads:
        dx, dy = q[0]-p[0], q[1]-p[1]; l2 = dx*dx+dy*dy
        if l2 < 1e-9: continue
        t = max(0, min(1, ((e-p[0])*dx + (n-p[1])*dy)/l2))
        if (e-(p[0]+t*dx))**2 + (n-(p[1]+t*dy))**2 < d*d: return True
    return False

rng = np.random.default_rng(20260912)
placed = []
for _ in range(260000):
    if len(placed) >= 1250: break
    ang = rng.random()*2*math.pi; rad = math.sqrt(rng.random())*(RADIUS-3)
    e, n = math.cos(ang)*rad, math.sin(ang)*rad
    v, _ = lookup(e, n)
    if not v: continue
    if any((e-pe)**2+(n-pn)**2 < 30.25 for pe, pn, _ in placed): continue
    if any(inside((e,n), r) for r in blocked): continue
    if near_road(e, n): continue
    placed.append((round(e,2), round(n,2), round(min(1.0, max(0.25, density(e,n))),3)))

rings = [0]*4
for e,n,_ in placed: rings[min(3, int(math.hypot(e,n)//50))] += 1
print(f"\nplaced {len(placed)} trees; by distance ring 0-50/50-100/100-150/150-200m: {rings}")
json.dump({"radius": RADIUS, "trees": placed}, open('data/trees.json','w'))
