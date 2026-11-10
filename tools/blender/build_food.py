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
from build_assets import OUT, PREV, join, reset  # noqa: E402

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
    """Join an item's parts into one mesh under an empty called `name` placed at `at` (origin at its base)."""
    mesh = join(parts, f"{name}_mesh", origin=(0, 0, 0))
    k = SCALE.get(name, 1)
    if k != 1:
        mesh.scale = (k, k, k)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    e = bpy.context.active_object
    e.name = name
    mesh.parent = e
    e.location = at
    return e


SCALE = {"lobster": 0.8}
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
    sack = add("primitive_uv_sphere_add", "sack", MATTE, radius=0.15, location=(0, 0, 0.15), segments=14, ring_count=8)
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
    b = add("primitive_uv_sphere_add", "bowl", CERAMIC, radius=0.17, location=(0, 0, 0.17), segments=24, ring_count=12)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for v in b.data.vertices:
        v.select = v.co.z > 0.0
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    b.modifiers.new("solid", "SOLIDIFY").thickness = 0.015
    smooth(b, 0)
    paint(b, lambda co, n: (0.12, 0.16, 0.32) if co.z > -0.03 else (0.9, 0.88, 0.82))
    rice = add("primitive_uv_sphere_add", "rice", MATTE, radius=0.15, location=(0, 0, 0.16), segments=16, ring_count=8)
    rice.scale = (1, 1, 0.45 * heap)
    bpy.ops.object.transform_apply(scale=True)
    smooth(rice, 1)
    bumpy(rice, 0.012, 0.012)  # grains
    paint(rice, fill_fn)
    parts = [b, rice]
    if burnt:
        for k in range(5):
            s = add("primitive_uv_sphere_add", f"smoke{k}", MATTE, radius=0.03, location=(random.uniform(-.06, .06), random.uniform(-.06, .06), 0.235), segments=8, ring_count=5)
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
    outer = add("primitive_cylinder_add", "nori", FOOD, radius=r, depth=length, location=(0, 0, r), rotation=(0, math.pi / 2, 0), vertices=18)
    smooth(outer, 0)
    paint(outer, lambda co, n: (0.06, 0.17, 0.09))
    inner = add("primitive_cylinder_add", "rice", MATTE, radius=r * 0.86, depth=length + 0.004, location=(0, 0, r), rotation=(0, math.pi / 2, 0), vertices=18)
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


def nori_cone(fills=(), rice=False):
    c = add("primitive_cone_add", "cone", FOOD, radius1=0.11, radius2=0.0, depth=0.32, location=(0, 0, 0.16), rotation=(math.pi, 0, 0), vertices=24)
    c.modifiers.new("solid", "SOLIDIFY").thickness = 0.01
    smooth(c, 0)
    paint(c, lambda co, n: mix((0.06, 0.17, 0.09), (0.12, 0.28, 0.14), noise.noise(co * 40) * 0.5 + 0.5))
    parts = [c]
    if rice:
        r = add("primitive_uv_sphere_add", "rice", MATTE, radius=0.1, location=(0, 0, 0.31), segments=14, ring_count=7)
        r.scale = (1, 1, 0.4)
        bumpy(r, 0.006, 0.012)
        paint(r, solid((0.97, 0.96, 0.92)))
        parts.append(r)
    for k, col in enumerate(fills):
        s = add("primitive_uv_sphere_add", f"fill{k}", FOOD, radius=0.045, location=((k - (len(fills) - 1) / 2) * 0.05, 0, 0.34 + (k % 2) * 0.02), segments=10, ring_count=6)
        smooth(s, 0)
        paint(s, solid(col))
        parts.append(s)
    return parts

def fish_whole(skin=(0.32, 0.45, 0.62), belly=(0.86, 0.88, 0.9)):
    body = add("primitive_uv_sphere_add", "body", GLAZE, radius=0.1, location=(0, 0, 0.08), segments=18, ring_count=10)
    body.scale = (2.1, 0.85, 0.8)
    bpy.ops.object.transform_apply(scale=True)
    smooth(body, 1)
    paint(body, lambda co, n: mix(belly, skin, (co.z - 0.05) * 14 + 0.5) if math.sin(co.x * 90) < 0.85 else mix(skin, (0.15, 0.2, 0.3), 0.5))
    tail = add("primitive_cone_add", "tail", GLAZE, radius1=0.08, depth=0.1, location=(-0.24, 0, 0.08), rotation=(0, math.pi / 2, 0), vertices=4)
    tail.scale = (1, 0.25, 1)
    paint(tail, solid(skin))
    eye = add("primitive_uv_sphere_add", "eye", GLAZE, radius=0.022, location=(0.165, -0.055, 0.1), segments=8, ring_count=5)
    paint(eye, solid((0.03, 0.03, 0.03)))
    return [body, tail, eye]


def slab_parts(fn, n=3, w=0.17, h=0.045, d=0.1, mat=None):
    parts = []
    for k in range(n):
        s = add("primitive_cube_add", f"slab{k}", mat or GLAZE, size=1, location=((k - (n - 1) / 2) * w * 0.82, 0, h / 2 + 0.002 + k * 0.006))
        s.scale = (w, d, h)
        s.rotation_euler = (0, 0.12, 0.25 * (k - 1))
        bpy.ops.object.transform_apply(scale=True)
        dense(s, 4)
        s.modifiers.new("bev", "BEVEL").width = 0.01
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
    """A curled red lobster: carapace, a segmented tail ending in a fan, two big claws and long feelers."""
    shell, dark = (0.86, 0.16, 0.1), (0.45, 0.05, 0.04)
    sh = lambda co, n: mix(shell, dark, 0.15 + 0.5 * max(0, n.z) * (0.5 + 0.5 * noise.noise(co * 30)))
    parts = []
    head = add("primitive_uv_sphere_add", "head", GLAZE, radius=0.08, location=(0.04, 0, 0.07), segments=14, ring_count=8)
    head.scale = (1.4, 0.9, 0.8)
    bpy.ops.object.transform_apply(scale=True)
    smooth(head, 0)
    paint(head, sh)
    parts.append(head)
    for k in range(5):
        t = k / 4
        seg = add("primitive_uv_sphere_add", f"seg{k}", GLAZE, radius=0.062 - k * 0.007, location=(-0.08 - k * 0.055, 0, 0.06 - t * t * 0.03), segments=12, ring_count=7)
        seg.scale = (0.75, 1, 0.7)
        bpy.ops.object.transform_apply(scale=True)
        smooth(seg, 0)
        paint(seg, sh)
        parts.append(seg)
    fan = add("primitive_uv_sphere_add", "fan", GLAZE, radius=0.06, location=(-0.36, 0, 0.03), segments=10, ring_count=6)
    fan.scale = (0.8, 1.3, 0.2)
    paint(fan, solid(shell))
    parts.append(fan)
    for s in (-1, 1):
        arm = add("primitive_cylinder_add", f"arm{s}", GLAZE, radius=0.016, depth=0.12, location=(0.15, s * 0.07, 0.06), rotation=(0, math.pi / 2, s * 0.6), vertices=8)
        paint(arm, solid(shell))
        claw = add("primitive_uv_sphere_add", f"claw{s}", GLAZE, radius=0.05, location=(0.24, s * 0.11, 0.065), segments=12, ring_count=7)
        claw.scale = (1.5, 0.85, 0.6)
        claw.rotation_euler = (0, 0, s * 0.3)
        smooth(claw, 0)
        paint(claw, sh)
        pin = add("primitive_cone_add", f"pin{s}", GLAZE, radius1=0.022, depth=0.08, location=(0.33, s * 0.14, 0.07), rotation=(0, math.pi / 2, s * 0.3), vertices=8)
        paint(pin, solid(shell))
        ant = add("primitive_cylinder_add", f"ant{s}", FOOD, radius=0.005, depth=0.3, location=(0.2, s * 0.04, 0.14), rotation=(0, math.radians(65), s * 0.35), vertices=5)
        paint(ant, solid(shell))
        eye = add("primitive_uv_sphere_add", f"eye{s}", GLAZE, radius=0.014, location=(0.13, s * 0.035, 0.12), segments=6, ring_count=4)
        paint(eye, solid((0.02, 0.02, 0.02)))
        for j in range(3):
            leg = add("primitive_cylinder_add", f"leg{s}{j}", FOOD, radius=0.007, depth=0.09, location=(0.02 - j * 0.04, s * 0.08, 0.03), rotation=(s * 1.0, 0, 0), vertices=5)
            paint(leg, solid(dark))
            parts.append(leg)
        parts += [arm, claw, pin, ant, eye]
    return parts

def tomato_whole():
    t = add("primitive_uv_sphere_add", "tomato", GLAZE, radius=0.12, location=(0, 0, 0.11), segments=16, ring_count=10)
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
    """Three rounds: a red skin ring, a juicier flesh disc and seed pockets; blistered ones are charred."""
    skin = (0.9, 0.12, 0.08)
    flesh = (1.0, 0.36, 0.24)
    seed = (1.0, 0.78, 0.45)
    char = (0.3, 0.05, 0.03)
    parts = []
    for k in range(3):
        x, z, tilt = (k - 1) * 0.12, 0.014 + (k == 1) * 0.01, 0.12 * (k - 1)
        ring = add("primitive_cylinder_add", f"ring{k}", GLAZE, radius=0.09, depth=0.026, location=(x, 0, z), vertices=20, rotation=(tilt, 0, 0))
        ring.modifiers.new("bev", "BEVEL").width = 0.006
        smooth(ring, 0)
        paint(ring, (lambda co, n: mix(skin, char, 0.35 + 0.4 * max(0, noise.noise(co * 40)))) if blister else solid(skin))
        disc = add("primitive_cylinder_add", f"flesh{k}", GLAZE, radius=0.074, depth=0.03, location=(x, 0, z), vertices=20, rotation=(tilt, 0, 0))
        paint(disc, (lambda co, n: mix(flesh, char, 0.3 + 0.35 * max(0, noise.noise(co * 35)))) if blister else solid(flesh))
        parts += [ring, disc]
        for j in range(5):
            a = j / 5 * math.tau + k
            sd = add("primitive_uv_sphere_add", f"seed{k}{j}", GLAZE, radius=0.022, location=(x + math.cos(a) * 0.042, math.sin(a) * 0.042 * math.cos(tilt), z + 0.015 + math.sin(a) * 0.042 * math.sin(tilt)), segments=6, ring_count=4)
            sd.scale = (1, 1, 0.35)
            paint(sd, solid(mix(seed, char, 0.4) if blister else seed))
            parts.append(sd)
        if blister:
            for j in range(3):
                b = add("primitive_uv_sphere_add", f"blister{k}{j}", MATTE, radius=0.016, location=(x + random.uniform(-0.05, 0.05), random.uniform(-0.05, 0.05), z + 0.018), segments=6, ring_count=4)
                b.scale = (1, 1, 0.5)
                paint(b, solid((0.08, 0.03, 0.02)))
                parts.append(b)
    return parts


def avocado_whole():
    """A halved avocado lying cut side up: dark skin, pale flesh and a big brown stone."""
    a = add("primitive_uv_sphere_add", "skin", MATTE, radius=0.1, location=(0, 0, 0.0), segments=16, ring_count=10)
    a.scale = (1.35, 1, 1)
    bpy.ops.object.transform_apply(scale=True)
    for v in a.data.vertices:
        v.co.y *= 1 - 0.25 * max(0, v.co.x / 0.135)  # pear-shaped
    for v in a.data.vertices:
        v.co.z = min(v.co.z, 0.0) + 0.1  # cut flat at the top, base at z=0
    a.location = (0, 0, 0)
    smooth(a, 1)
    paint(a, lambda co, n: mix((0.95, 0.92, 0.5), (0.55, 0.75, 0.25), min(1, math.hypot(co.x * 0.8, co.y) * 9)) if co.z > 0.098 else mix((0.1, 0.18, 0.06), (0.2, 0.3, 0.1), noise.noise(co * 40) * 0.5 + 0.5))
    pit = add("primitive_uv_sphere_add", "pit", GLAZE, radius=0.048, location=(-0.025, 0, 0.1), segments=12, ring_count=7)
    pit.scale = (1.1, 1, 0.8)
    paint(pit, lambda co, n: mix((0.55, 0.3, 0.14), (0.35, 0.18, 0.08), noise.noise(co * 50) * 0.5 + 0.5))
    return [a, pit]

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
    """A knobbly rhizome with big bright leaves on top."""
    parts = []
    for k, (z, r) in enumerate([(0.04, 0.055), (0.095, 0.058), (0.15, 0.052), (0.2, 0.045)]):
        s = add("primitive_uv_sphere_add", f"knob{k}", MATTE, radius=r, location=(0.006 * (k % 2), 0, z), segments=12, ring_count=7)
        s.scale = (1, 1, 0.8)
        smooth(s, 0)
        paint(s, lambda co, n: mix((0.55, 0.7, 0.32), (0.36, 0.48, 0.2), noise.noise(co * 40) * 0.5 + 0.5))
        parts.append(s)
    for k in range(3):
        a = k * 2.1
        stem = add("primitive_cylinder_add", f"stem{k}", FOOD, radius=0.008, depth=0.12, location=(math.cos(a) * 0.02, math.sin(a) * 0.02, 0.27), vertices=6, rotation=(math.sin(a) * -0.35, math.cos(a) * 0.35, 0))
        paint(stem, solid((0.3, 0.55, 0.2)))
        leaf = add("primitive_uv_sphere_add", f"leaf{k}", FOOD, radius=0.07, location=(math.cos(a) * 0.06, math.sin(a) * 0.06, 0.33), segments=12, ring_count=6)
        leaf.scale = (1, 1, 0.25)
        paint(leaf, lambda co, n: mix((0.1, 0.36, 0.1), (0.24, 0.55, 0.16), max(0, n.z)))
        parts += [stem, leaf]
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
    """White porcelain with an indigo rim: the rim body, then a white well on top."""
    p = add("primitive_cylinder_add", "plate", CERAMIC, radius=0.28, depth=0.03, location=(0, 0, 0.015), vertices=32)
    p.modifiers.new("bev", "BEVEL").width = 0.01
    smooth(p, 0)
    paint(p, lambda co, n: (0.16, 0.28, 0.62) if co.z > 0 else (0.95, 0.95, 0.93))
    well = add("primitive_cylinder_add", "well", CERAMIC, radius=0.215, depth=0.006, location=(0, 0, 0.031), vertices=32)
    paint(well, solid((0.98, 0.98, 0.96)))
    return [p, well]

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
    cone = join(nori_cone([FILL["fish"], FILL["avocado"], FILL["tomato"]], rice=True), "temaki", origin=(0, 0, 0))
    cone.rotation_euler = (math.radians(62), 0, math.radians(-20))
    cone.location = (0.03, 0.15, 0.055)
    return parts + [cone]

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
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True, use_selection=False, export_texcoords=False)
    print(f"exported {path} ({os.path.getsize(path) // 1024} KB)")


def preview():
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_EEVEE_NEXT"
    scn.render.resolution_x, scn.render.resolution_y = 1600, 1000
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
    # labels under each item (preview only; the glb is already exported)
    lab = bpy.data.materials.new("Label")
    lab.use_nodes = True
    lab.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.85, 0.75, 1)
    for i, name in enumerate(ITEMS):
        x, y = (i % 8) * SPACING, (i // 8) * SPACING
        bpy.ops.object.text_add(location=(x, y - 0.27, 0.0))
        t = bpy.context.active_object
        t.data.body = name
        t.data.size = 0.06
        t.data.align_x = "CENTER"
        t.data.materials.append(lab)
    cx, cy = 3.5 * SPACING, 1.5 * SPACING
    bpy.ops.object.camera_add(location=(cx, cy - 4.0, 4.6))
    cam = bpy.context.active_object
    cam.rotation_euler = (math.radians(41), 0, 0)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 6.0
    scn.camera = cam
    scn.render.filepath = os.path.join(PREV, "food.png")
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    build()
    preview()
