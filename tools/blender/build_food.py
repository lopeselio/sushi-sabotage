"""Builds every ingredient, in every cooking state, plus the finished dishes, into one food.glb.

Run headless:  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_food.py
Outputs:       apps/web/public/models/food.glb and tools/blender/previews/food.png

Each item is a top-level empty named after its sim ItemKind (e.g. "fish_seared"), with its meshes
as children, resting on z=0. Cooking states are painted into vertex colours from the script
(grill stripes, browning, char), and organic surfaces get a little displacement, so the look survives
glTF export without image textures. Chunky, saturated and readable from the game camera.
"""
import math
import os
import random
import sys

import bpy
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(__file__))
from build_assets import OUT, PREV, reset  # noqa: E402

random.seed(7)
SPACING = 0.7


# ---------- helpers ----------

def vc_mat(name, rough=0.45, metal=0.0, clearcoat=0.0):
    """A material whose base colour comes from the mesh's vertex colours."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if "Coat Weight" in b.inputs:
        b.inputs["Coat Weight"].default_value = clearcoat
    ca = nt.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    nt.links.new(ca.outputs["Color"], b.inputs["Base Color"])
    return m


def paint(obj, fn):
    """Paint vertex colours: fn(local_co, normal) -> (r, g, b)."""
    me = obj.data
    if "Col" not in me.color_attributes:
        me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="POINT")
    col = me.color_attributes["Col"]
    for v in me.vertices:
        r, g, b = fn(v.co, v.normal)
        # colours here are authored as sRGB picks; the attribute stores linear
        lin = [min(1, max(0, x)) ** 2.2 for x in (r, g, b)]
        col.data[v.index].color = (lin[0], lin[1], lin[2], 1.0)


def dense(obj, cuts=6):
    """Subdivide (in place) so vertex-colour detail has enough vertices."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=cuts)
    bpy.ops.object.mode_set(mode="OBJECT")


def mix(a, b, t):
    t = min(1, max(0, t))
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


def smooth(obj, subdiv=1):
    for p in obj.data.polygons:
        p.use_smooth = True
    if subdiv:
        m = obj.modifiers.new("sub", "SUBSURF")
        m.levels = subdiv
        m.render_levels = subdiv


def bumpy(obj, strength=0.01, scale=0.08):
    tex = bpy.data.textures.new(f"{obj.name}_n", "CLOUDS")
    tex.noise_scale = scale
    d = obj.modifiers.new("disp", "DISPLACE")
    d.texture = tex
    d.strength = strength
    d.mid_level = 0.5


def apply_all(obj):
    bpy.context.view_layer.objects.active = obj
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def add(prim, name, mat, **kw):
    getattr(bpy.ops.mesh, prim)(**kw)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o


def group(name, parts, at):
    """Parent parts under an empty called `name` placed at `at` (the item's origin is its base)."""
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    e = bpy.context.active_object
    e.name = name
    for p in parts:
        apply_all(p)
        p.parent = e
    e.location = at
    return e


_slot = [0]


def next_slot():
    i = _slot[0]
    _slot[0] += 1
    return ((i % 8) * SPACING, (i // 8) * SPACING, 0)


# ---------- shared materials ----------

FOOD = None  # vertex-colour material, glossy
MATTE = None
GLAZE = None
CERAMIC = None


def mats():
    global FOOD, MATTE, GLAZE, CERAMIC
    FOOD = vc_mat("Food", rough=0.42)
    MATTE = vc_mat("FoodMatte", rough=0.8)
    GLAZE = vc_mat("FoodGlaze", rough=0.22, clearcoat=0.6)
    CERAMIC = vc_mat("Ceramic", rough=0.18, clearcoat=0.4)


# ---------- colour functions ----------

def solid(c):
    return lambda co, n: c


def speckle(c, amt=0.08, sc=40):
    return lambda co, n: tuple(x * (1 - amt + amt * 2 * noise.noise(co * sc)) for x in c)


def seared(base, crust, stripes=True, char=0.0):
    """Golden-brown top, grill stripes, darker edges; `char` pushes towards black."""
    black = (0.04, 0.03, 0.03)

    def f(co, n):
        c = base
        top = max(0.0, n.z)
        c = mix(c, crust, 0.35 + 0.4 * top)
        if stripes and n.z > 0.4 and math.sin((co.x + co.y) * 80) > 0.5:
            c = mix(c, (0.14, 0.05, 0.02), 0.9)
        edge = 1 - abs(n.z)
        c = mix(c, (0.35, 0.15, 0.05), 0.4 * edge)
        if char:
            c = mix(c, black, char * (0.75 + 0.25 * noise.noise(co * 30)))
        return c
    return f


# ---------- items ----------

def rice_raw():
    sack = add("primitive_uv_sphere_add", "sack", MATTE, radius=0.15, location=(0, 0, 0.15), segments=20, ring_count=12)
    sack.scale = (1, 0.85, 1.15)
    bpy.ops.object.transform_apply(scale=True)
    smooth(sack)
    bumpy(sack, 0.012, 0.05)
    paint(sack, speckle((0.82, 0.68, 0.45), 0.12, 30))
    tie = add("primitive_torus_add", "tie", FOOD, major_radius=0.06, minor_radius=0.018, location=(0, 0, 0.3))
    paint(tie, solid((0.75, 0.12, 0.1)))
    top = add("primitive_cone_add", "top", MATTE, radius1=0.07, radius2=0.11, depth=0.08, location=(0, 0, 0.35))
    paint(top, speckle((0.82, 0.68, 0.45), 0.12, 30))
    label = add("primitive_cube_add", "label", FOOD, size=1, location=(0, -0.125, 0.15))
    label.scale = (0.1, 0.01, 0.07)
    paint(label, solid((0.95, 0.94, 0.9)))
    return [sack, tie, top, label]


def bowl(fill_fn, heap=1.0, burnt=False):
    b = add("primitive_uv_sphere_add", "bowl", CERAMIC, radius=0.17, location=(0, 0, 0.17), segments=28, ring_count=14)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for v in b.data.vertices:
        v.select = v.co.z > 0.0
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    b.modifiers.new("solid", "SOLIDIFY").thickness = 0.015
    smooth(b, 1)
    paint(b, lambda co, n: (0.12, 0.16, 0.32) if co.z > -0.03 else (0.9, 0.88, 0.82))
    rice = add("primitive_uv_sphere_add", "rice", MATTE, radius=0.15, location=(0, 0, 0.16), segments=24, ring_count=12)
    rice.scale = (1, 1, 0.45 * heap)
    bpy.ops.object.transform_apply(scale=True)
    smooth(rice, 1)
    bumpy(rice, 0.012, 0.012)  # grains
    paint(rice, fill_fn)
    parts = [b, rice]
    if burnt:
        for k in range(5):
            s = add("primitive_uv_sphere_add", f"smoke{k}", MATTE, radius=0.025, location=(random.uniform(-.06, .06), random.uniform(-.06, .06), 0.24))
            paint(s, solid((0.05, 0.04, 0.04)))
            parts.append(s)
    return parts


def rice_cooked():
    return bowl(lambda co, n: mix((0.97, 0.96, 0.92), (0.88, 0.86, 0.8), noise.noise(co * 60) * 0.5 + 0.5))


def rice_burnt():
    return bowl(lambda co, n: mix((0.07, 0.05, 0.04), (0.35, 0.22, 0.1), max(0, noise.noise(co * 25))), burnt=True)


def sushi_rice():
    o = add("primitive_cube_add", "block", MATTE, size=1, location=(0, 0, 0.06))
    o.scale = (0.26, 0.18, 0.12)
    bpy.ops.object.transform_apply(scale=True)
    o.modifiers.new("bev", "BEVEL").width = 0.035
    smooth(o, 1)
    bumpy(o, 0.008, 0.01)
    paint(o, lambda co, n: mix((0.98, 0.97, 0.93), (0.9, 0.88, 0.82), noise.noise(co * 70) * 0.5 + 0.5))
    return [o]


def nori_sheet():
    o = add("primitive_cube_add", "sheet", FOOD, size=1, location=(0, 0, 0.012))
    o.scale = (0.3, 0.24, 0.018)
    bpy.ops.object.transform_apply(scale=True)
    o.modifiers.new("bev", "BEVEL").width = 0.005
    bumpy(o, 0.004, 0.03)
    paint(o, lambda co, n: mix((0.06, 0.16, 0.08), (0.12, 0.26, 0.13), noise.noise(co * 45) * 0.5 + 0.5))
    return [o]


def roll_parts(fill_colors, length=0.3, r=0.09):
    outer = add("primitive_cylinder_add", "nori", FOOD, radius=r, depth=length, location=(0, 0, r), rotation=(0, math.pi / 2, 0), vertices=24)
    smooth(outer, 0)
    paint(outer, lambda co, n: (0.06, 0.17, 0.09))
    inner = add("primitive_cylinder_add", "rice", MATTE, radius=r * 0.86, depth=length + 0.004, location=(0, 0, r), rotation=(0, math.pi / 2, 0), vertices=24)
    bumpy(inner, 0.004, 0.01)
    paint(inner, lambda co, n: (0.97, 0.96, 0.92))
    parts = [outer, inner]
    for k, c in enumerate(fill_colors):
        a = k * 2.4
        f = add("primitive_cylinder_add", f"fill{k}", FOOD, radius=r * 0.28, depth=length + 0.008, location=(0, math.cos(a) * r * 0.35, r + math.sin(a) * r * 0.35), rotation=(0, math.pi / 2, 0), vertices=12)
        paint(f, solid(c))
        parts.append(f)
    return parts


def nori_roll():
    return roll_parts([])


def nori_cone(fills=()):
    c = add("primitive_cone_add", "cone", FOOD, radius1=0.11, radius2=0.0, depth=0.32, location=(0, 0, 0.16), rotation=(math.pi, 0, 0), vertices=24)
    c.modifiers.new("solid", "SOLIDIFY").thickness = 0.01
    smooth(c, 0)
    paint(c, lambda co, n: mix((0.06, 0.17, 0.09), (0.12, 0.28, 0.14), noise.noise(co * 40) * 0.5 + 0.5))
    parts = [c]
    for k, col in enumerate(fills):
        s = add("primitive_uv_sphere_add", f"fill{k}", FOOD, radius=0.045, location=((k - (len(fills) - 1) / 2) * 0.05, 0, 0.31 + (k % 2) * 0.02))
        smooth(s, 0)
        paint(s, solid(col))
        parts.append(s)
    return parts


def fish_whole(skin=(0.32, 0.45, 0.62), belly=(0.86, 0.88, 0.9)):
    body = add("primitive_uv_sphere_add", "body", GLAZE, radius=0.1, location=(0, 0, 0.08), segments=24, ring_count=12)
    body.scale = (2.1, 0.85, 0.8)
    bpy.ops.object.transform_apply(scale=True)
    smooth(body, 1)
    paint(body, lambda co, n: mix(belly, skin, (co.z - 0.05) * 14 + 0.5) if math.sin(co.x * 90) < 0.85 else mix(skin, (0.15, 0.2, 0.3), 0.5))
    tail = add("primitive_cone_add", "tail", GLAZE, radius1=0.08, depth=0.1, location=(-0.24, 0, 0.08), rotation=(0, math.pi / 2, 0), vertices=4)
    tail.scale = (1, 0.25, 1)
    paint(tail, solid(skin))
    eye = add("primitive_uv_sphere_add", "eye", GLAZE, radius=0.018, location=(0.16, -0.06, 0.1))
    paint(eye, solid((0.03, 0.03, 0.03)))
    return [body, tail, eye]


def slab_parts(fn, n=3, w=0.17, h=0.045, d=0.1, mat=None):
    parts = []
    for k in range(n):
        s = add("primitive_cube_add", f"slab{k}", mat or GLAZE, size=1, location=((k - (n - 1) / 2) * w * 0.82, 0, h / 2 + 0.002 + k * 0.006))
        s.scale = (w, d, h)
        s.rotation_euler = (0, 0.12, 0.25 * (k - 1))
        bpy.ops.object.transform_apply(scale=True)
        dense(s, 8)
        s.modifiers.new("bev", "BEVEL").width = 0.012
        smooth(s, 0)
        paint(s, fn)
        parts.append(s)
    return parts


def salmon(co, n):
    # salmon with white fat lines
    return (1.0, 0.86, 0.76) if math.sin(co.x * 70 + co.y * 25) > 0.93 else (1.0, 0.45, 0.25)


def lobster_meat(co, n):
    return mix((1.0, 0.95, 0.9), (0.95, 0.3, 0.2), max(0, n.z) * (0.6 + 0.4 * math.sin(co.x * 80)))


def lobster_whole():
    shell = (0.82, 0.15, 0.1)
    parts = []
    for k in range(5):
        seg = add("primitive_uv_sphere_add", f"seg{k}", GLAZE, radius=0.07 - k * 0.007, location=(-k * 0.06, 0, 0.06), segments=16, ring_count=10)
        seg.scale = (0.8, 1, 0.75)
        bpy.ops.object.transform_apply(scale=True)
        paint(seg, lambda co, n: mix(shell, (0.5, 0.06, 0.05), max(0, -n.z)))
        parts.append(seg)
    for y in (-0.08, 0.08):
        claw = add("primitive_uv_sphere_add", f"claw{y}", GLAZE, radius=0.05, location=(0.12, y, 0.06), segments=16, ring_count=10)
        claw.scale = (1.4, 0.8, 0.7)
        bpy.ops.object.transform_apply(scale=True)
        paint(claw, solid(shell))
        parts.append(claw)
    for y in (-0.025, 0.025):
        ant = add("primitive_cylinder_add", f"ant{y}", FOOD, radius=0.005, depth=0.16, location=(0.12, y, 0.11), rotation=(0, math.radians(60), 0), vertices=6)
        paint(ant, solid(shell))
        parts.append(ant)
    return parts


def tomato_whole():
    t = add("primitive_uv_sphere_add", "tomato", GLAZE, radius=0.12, location=(0, 0, 0.11), segments=24, ring_count=14)
    t.scale = (1, 1, 0.85)
    bpy.ops.object.transform_apply(scale=True)
    smooth(t, 1)
    paint(t, lambda co, n: mix((0.88, 0.1, 0.08), (1.0, 0.35, 0.25), max(0, n.x * 0.3 + n.z * 0.3)))
    leaf = add("primitive_cone_add", "leaf", FOOD, radius1=0.05, depth=0.02, location=(0, 0, 0.215), vertices=5)
    paint(leaf, solid((0.2, 0.5, 0.15)))
    stem = add("primitive_cylinder_add", "stem", FOOD, radius=0.008, depth=0.04, location=(0, 0, 0.235))
    paint(stem, solid((0.2, 0.45, 0.13)))
    return [t, leaf, stem]


def tomato_rounds(blister=False):
    parts = []
    for k in range(3):
        r = add("primitive_cylinder_add", f"round{k}", GLAZE, radius=0.09, depth=0.025, location=((k - 1) * 0.11, 0, 0.0125 + k * 0.008), vertices=32, end_fill_type="TRIFAN")
        dense(r, 3)
        r.rotation_euler = (0.15 * (k - 1), 0.1, 0)
        r.modifiers.new("bev", "BEVEL").width = 0.006
        smooth(r, 0)
        if blister:
            bumpy(r, 0.008, 0.02)

        def f(co, n, blister=blister):
            rad = math.hypot(co.x, co.y)
            c = (0.9, 0.12, 0.08) if rad > 0.075 else ((1.0, 0.5, 0.35) if rad > 0.03 and math.sin(math.atan2(co.y, co.x) * 6) > 0.4 else (0.98, 0.3, 0.2))
            if blister:
                c = mix(c, (0.35, 0.05, 0.03), 0.45 + 0.3 * max(0, noise.noise(co * 40)))
            return c
        paint(r, f)
        parts.append(r)
    return parts


def avocado_whole():
    a = add("primitive_uv_sphere_add", "avocado", MATTE, radius=0.1, location=(0, 0, 0.13), segments=24, ring_count=14)
    a.scale = (1, 1, 1.35)
    bpy.ops.object.transform_apply(scale=True)
    for v in a.data.vertices:
        v.co.x *= 1 - 0.25 * max(0, (v.co.z - 0.13) / 0.13)
        v.co.y *= 1 - 0.25 * max(0, (v.co.z - 0.13) / 0.13)
    smooth(a, 1)
    bumpy(a, 0.006, 0.015)
    paint(a, lambda co, n: mix((0.12, 0.22, 0.08), (0.24, 0.36, 0.12), noise.noise(co * 40) * 0.5 + 0.5))
    return [a]


def avocado_diced():
    parts = []
    for k in range(7):
        c = add("primitive_cube_add", f"dice{k}", GLAZE, size=0.065, location=(((k % 3) - 1) * 0.072, ((k // 3) % 2) * 0.07 - 0.035, 0.033 + (k // 6) * 0.06))
        c.rotation_euler = (random.uniform(-.2, .2), random.uniform(-.2, .2), random.uniform(-.5, .5))
        c.modifiers.new("bev", "BEVEL").width = 0.01
        smooth(c, 0)
        paint(c, lambda co, n: mix((0.85, 0.9, 0.42), (0.45, 0.65, 0.2), max(0, -n.z) + 0.2 * noise.noise(co * 50)))
        parts.append(c)
    return parts


def wasabi_root():
    w = add("primitive_cylinder_add", "root", MATTE, radius=0.05, depth=0.24, location=(0, 0, 0.12), vertices=16)
    for v in w.data.vertices:
        v.co.x *= 1 + 0.15 * math.sin(v.co.z * 60)
        v.co.y *= 1 + 0.15 * math.sin(v.co.z * 60)
    smooth(w, 1)
    bumpy(w, 0.008, 0.02)
    paint(w, lambda co, n: mix((0.45, 0.62, 0.28), (0.3, 0.42, 0.18), max(0, math.sin(co.z * 60))))
    parts = [w]
    for k in range(3):
        leaf = add("primitive_uv_sphere_add", f"leaf{k}", FOOD, radius=0.06, location=(math.cos(k * 2.1) * 0.04, math.sin(k * 2.1) * 0.04, 0.27))
        leaf.scale = (1, 1, 0.3)
        paint(leaf, solid((0.18, 0.5, 0.15)))
        parts.append(leaf)
    return parts


def wasabi_slices():
    parts = []
    for k in range(5):
        d = add("primitive_cylinder_add", f"disc{k}", MATTE, radius=0.04, depth=0.018, location=((k - 2) * 0.05, 0, 0.009 + (k % 2) * 0.012), vertices=16)
        d.rotation_euler = (0.2 * ((k % 2) - 0.5), 0, 0)
        smooth(d, 0)
        paint(d, lambda co, n: mix((0.65, 0.85, 0.4), (0.4, 0.6, 0.22), math.hypot(co.x, co.y) * 20))
        parts.append(d)
    return parts


def wasabi_chutney():
    return bowl(lambda co, n: mix((0.48, 0.72, 0.28), (0.35, 0.55, 0.18), noise.noise(co * 35) * 0.5 + 0.5), heap=0.8)


def plate():
    p = add("primitive_cylinder_add", "plate", CERAMIC, radius=0.28, depth=0.03, location=(0, 0, 0.015), vertices=40)
    p.modifiers.new("bev", "BEVEL").width = 0.012
    smooth(p, 0)
    paint(p, lambda co, n: (0.15, 0.3, 0.6) if math.hypot(co.x, co.y) > 0.25 and co.z > 0 else (0.97, 0.97, 0.95))
    return [p]


FILL = {
    "fish": (1.0, 0.5, 0.33), "lobster": (0.95, 0.35, 0.25), "tomato": (0.8, 0.15, 0.1),
    "avocado": (0.75, 0.85, 0.35), "wasabi": (0.6, 0.85, 0.35),
}


def dish_maki():
    parts = plate()
    for k in range(6):
        a = k / 6 * math.tau
        piece = roll_parts([FILL["fish"], FILL["avocado"], FILL["tomato"]], length=0.08, r=0.07)
        for p in piece:
            p.rotation_euler.rotate_axis("Y", math.pi / 2)
            p.location = (p.location.x + math.cos(a) * 0.15, p.location.y + math.sin(a) * 0.15, p.location.z - 0.07 + 0.07)
        parts += piece
    dab = add("primitive_uv_sphere_add", "wasabi_dab", MATTE, radius=0.035, location=(0, 0, 0.045))
    dab.scale = (1, 1, 0.6)
    paint(dab, solid(FILL["wasabi"]))
    return parts + [dab]


def dish_temaki():
    parts = plate()
    cone = nori_cone([FILL["fish"], FILL["avocado"], FILL["tomato"]])
    for p in cone:
        p.rotation_euler.rotate_axis("X", -0.9)
        p.location = (p.location.x, p.location.y - 0.04, p.location.z + 0.06)
    return parts + cone


ITEMS = {
    "rice_raw": rice_raw, "rice_cooked": rice_cooked, "rice_burnt": rice_burnt, "sushi_rice": sushi_rice,
    "nori_sheet": nori_sheet, "nori_roll": nori_roll, "nori_cone": nori_cone,
    "fish": fish_whole,
    "fish_sliced": lambda: slab_parts(salmon),
    "fish_seared": lambda: slab_parts(seared((1.0, 0.5, 0.33), (0.85, 0.45, 0.18))),
    "fish_burnt": lambda: slab_parts(seared((0.3, 0.15, 0.1), (0.1, 0.05, 0.03), char=0.85), mat=MATTE),
    "lobster": lobster_whole,
    "lobster_sliced": lambda: slab_parts(lobster_meat, w=0.15, h=0.05),
    "lobster_seared": lambda: slab_parts(seared((1.0, 0.88, 0.8), (0.92, 0.4, 0.2)), w=0.15, h=0.05),
    "lobster_burnt": lambda: slab_parts(seared((0.3, 0.12, 0.08), (0.1, 0.05, 0.03), char=0.85), w=0.15, h=0.05, mat=MATTE),
    "tomato": tomato_whole,
    "tomato_sliced": tomato_rounds,
    "tomato_blistered": lambda: tomato_rounds(True),
    "avocado": avocado_whole, "avocado_diced": avocado_diced,
    "wasabi": wasabi_root, "wasabi_sliced": wasabi_slices, "wasabi_chutney": wasabi_chutney,
    "plate": plate, "dish_maki": dish_maki, "dish_temaki": dish_temaki,
}


def build():
    reset()
    mats()
    for name, fn in ITEMS.items():
        parts = fn()
        group(name, parts, next_slot())
    path = os.path.join(OUT, "food.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True, use_selection=False)
    print(f"exported {path} ({os.path.getsize(path) // 1024} KB)")


def preview():
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_EEVEE_NEXT"
    scn.render.resolution_x, scn.render.resolution_y = 1280, 720
    scn.view_settings.view_transform = "Standard"
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.12, 0.09, 0.14, 1)
    scn.world = w
    bpy.ops.object.light_add(type="SUN", location=(2, -2, 5))
    bpy.context.active_object.data.energy = 4
    bpy.context.active_object.rotation_euler = (math.radians(40), 0, math.radians(30))
    bpy.ops.object.light_add(type="AREA", location=(2.4, -1.5, 2))
    bpy.context.active_object.data.energy = 300
    bpy.context.active_object.data.size = 4
    cx, cy = 3.5 * SPACING, 1.0 * SPACING
    bpy.ops.object.camera_add(location=(cx, cy - 3.6, 3.6))
    cam = bpy.context.active_object
    cam.rotation_euler = (math.radians(45), 0, 0)
    cam.data.lens = 28
    scn.camera = cam
    scn.render.filepath = os.path.join(PREV, "food.png")
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    build()
    preview()
