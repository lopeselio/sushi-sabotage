"""Builds every Sushi Sabotage 3D asset (chef, stations, stall dressing) from code and exports .glb files.

Run headless:  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_assets.py [-- chef board ...]
Outputs:       apps/web/public/models/*.glb and tools/blender/previews/*.png

Toy-like, chunky shapes with bevels; flat colours via named materials. Materials whose name starts
with "Tint" are recoloured per chef at runtime ("TintDark" a shade darker). Static parts of each model
are joined into one object so a station costs a few draw calls; parts the game animates keep their own
object and name (handL/handR/footL/footR, blade, pan, flame, broth, lid, bell). No external textures.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "web", "public", "models")
PREV = os.path.join(ROOT, "tools", "blender", "previews")
os.makedirs(OUT, exist_ok=True)
os.makedirs(PREV, exist_ok=True)


# ---------- helpers ----------

_mats = {}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()  # materials die with the old file


def mat(name, rgb, rough=0.6, metal=0.0, emit=0.0):
    key = (name, rgb, rough, metal, emit)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit > 0:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    _mats[key] = m
    return m


def finish(obj, m, bevel=0.0, segments=2, smooth=True):
    obj.data.materials.clear()
    obj.data.materials.append(m)
    if bevel > 0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
        mod = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    return obj


def box(name, size, loc, m, bevel=0.03, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, m, bevel)


def cyl(name, r, h, loc, m, verts=24, bevel=0.02, rot=(0, 0, 0), r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return finish(o, m, bevel)


def sphere(name, r, loc, m, scale=(1, 1, 1), segs=20, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=max(6, segs // 2), radius=r, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, m)


def torus(name, R, r, loc, m, rot=(0, 0, 0), major=28, minor=10):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc, rotation=rot, major_segments=major, minor_segments=minor)
    o = bpy.context.active_object
    o.name = name
    return finish(o, m)


def cone(name, r, h, loc, m, verts=12, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=0, depth=h, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return finish(o, m)


def cull(o, keep):
    """Delete the vertices where keep(world_co) is false (the object must have no rotation or scale)."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    dead = [v for v in bm.verts if not keep(o.location + v.co)]
    bmesh.ops.delete(bm, geom=dead, context="VERTS")
    bm.to_mesh(o.data)
    bm.free()
    return o


def bake(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def join(objs, name, origin=None):
    """Apply modifiers and merge objects into one (one node, one primitive per material)."""
    for o in objs:
        bake(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name + "_mesh"
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if origin is not None:
        bpy.context.scene.cursor.location = origin
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
        bpy.context.scene.cursor.location = (0, 0, 0)
    return o


def group(name, objs, at=(0, 0, 0)):
    """An empty called `name` holding objs (for multi-asset .glb files)."""
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    e = bpy.context.active_object
    e.name = name
    for o in objs:
        o.parent = e
    e.location = at
    return e


def export(name):
    # apply modifiers into the export; Y-up glTF
    path = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True,
                              use_selection=False, export_cameras=False, export_lights=False, export_texcoords=False)
    print(f"exported {path} ({os.path.getsize(path) // 1024} KB)")


def preview(name, dist=3.2, height=1.6, target=(0, 0, 0.5), res=(480, 480), lens=50):
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_EEVEE_NEXT"
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.film_transparent = False
    scn.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.04, 0.08, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.2
    scn.world = world
    bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
    sun = bpy.context.active_object
    sun.data.energy = 2.5
    sun.data.color = (0.8, 0.85, 1.0)
    sun.rotation_euler = (math.radians(45), math.radians(10), math.radians(35))
    bpy.ops.object.light_add(type="POINT", location=(-1.5, -2.5, 2.5 + target[2]))
    bpy.context.active_object.data.energy = 300
    bpy.context.active_object.data.color = (1, 0.7, 0.45)
    bpy.ops.object.camera_add(location=(target[0] + dist * 0.8, target[1] - dist, height + target[2]))
    cam = bpy.context.active_object
    cam.data.lens = lens
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scn.camera = cam
    scn.render.filepath = os.path.join(PREV, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    for o in [o for o in bpy.data.objects if o.type in ("LIGHT", "CAMERA")]:
        bpy.data.objects.remove(o, do_unlink=True)


# ---------- palette ----------

WOOD = (0.36, 0.17, 0.09)       # lacquered cabinet
WOOD_D = (0.17, 0.08, 0.05)
WOOD_L = (0.93, 0.78, 0.55)     # hinoki
STONE = (0.42, 0.39, 0.36)
STEEL = (0.72, 0.74, 0.78)
IRON = (0.07, 0.07, 0.08)
DARK = (0.03, 0.025, 0.035)
RED = (0.72, 0.08, 0.06)
CREAM = (0.95, 0.91, 0.82)
SKIN = (1.0, 0.76, 0.58)
INDIGO = (0.06, 0.09, 0.26)
BRASS = (0.9, 0.66, 0.25)


def M_wood_d():
    return mat("WoodDark", WOOD_D, rough=0.6)


def M_light():
    return mat("BoardWood", WOOD_L, rough=0.75)


def M_steel():
    return mat("Steel", STEEL, rough=0.18, metal=1.0)


def M_brass():
    return mat("Brass", BRASS, rough=0.3, metal=1.0)


def M_glow():
    return mat("Glow", (1, 0.55, 0.1), emit=2.5)


def counter_base():
    """The shared counter body: lacquered wooden cabinet with a stone top, 1x1 cell, 0.9 tall."""
    wood, dark = mat("Wood", WOOD, rough=0.45), M_wood_d()
    parts = [
        box("cabinet", (0.94, 0.94, 0.78), (0, 0, 0.43), wood, bevel=0.03),
        box("kick", (0.88, 0.88, 0.08), (0, 0, 0.04), dark, bevel=0.01),
        box("top", (1.0, 1.0, 0.09), (0, 0, 0.855), mat("Stone", STONE, rough=0.3), bevel=0.025),
        box("lip", (1.0, 0.04, 0.03), (0, -0.49, 0.8), dark, bevel=0.008),
    ]
    for x in (-0.225, 0.225):
        parts.append(box(f"door{x}", (0.4, 0.03, 0.58), (x, -0.47, 0.44), dark, bevel=0.012))
        parts.append(box(f"panel{x}", (0.3, 0.02, 0.46), (x, -0.485, 0.44), wood, bevel=0.01))
        parts.append(sphere(f"knob{x}", 0.022, (x - math.copysign(0.14, x), -0.5, 0.55), M_brass(), segs=10))
    return parts


# ---------- the chef ----------

def chef_parts(tint_rgb=(0.9, 0.3, 0.2)):
    tint = mat("Tint", tint_rgb, rough=0.5)
    tint_d = mat("TintDark", tuple(c * 0.55 for c in tint_rgb), rough=0.55)
    band = mat("TintBand", tint_rgb, rough=0.6)
    skin = mat("Skin", SKIN, rough=0.65)
    apron = mat("Apron", CREAM, rough=0.8)
    hair = mat("Hair", (0.06, 0.04, 0.04), rough=0.55)
    eye = mat("Eye", DARK, rough=0.15)
    hi = mat("EyeHi", (1, 1, 1), rough=0.2, emit=1.5)
    cheek = mat("Cheek", (1.0, 0.42, 0.42), rough=0.7)
    shoe = mat("Shoe", (0.09, 0.07, 0.07), rough=0.5)
    H = 0.98  # head centre
    R = 0.27  # head radius
    stat = []
    # body: a chunky egg in the player's colour, a cream apron and a darker collar
    stat.append(sphere("torso", 0.3, (0, 0, 0.42), tint, scale=(1, 0.9, 1.08), segs=24))
    ap = sphere("apronShell", 0.312, (0, 0, 0.42), apron, scale=(1, 0.9, 1.08), segs=24)
    cull(ap, lambda co: co.y < -0.13 and abs(co.x) < 0.24 and 0.13 < co.z < 0.56)
    ap.modifiers.new("solid", "SOLIDIFY").thickness = 0.01
    stat.append(ap)
    stat.append(box("pocket", (0.14, 0.03, 0.07), (0, -0.3, 0.3), apron, bevel=0.015))
    col = torus("collar", 0.15, 0.04, (0, 0, 0.72), tint_d, major=20, minor=8)
    col.scale = (1, 1, 0.7)
    stat.append(col)
    # head
    stat.append(sphere("head", R, (0, 0, H), skin, segs=28))
    for x in (-R, R):
        stat.append(sphere(f"ear{x}", 0.055, (x * 0.98, 0.02, H - 0.02), skin, scale=(0.5, 1, 1), segs=12))
    hr = sphere("hair", R + 0.012, (0, 0, H), hair, segs=28)
    cull(hr, lambda co: co.z > H + 0.1 or (co.y > 0.02 and co.z > H - 0.2) or (co.y > -0.12 and co.z > H + 0.02))
    stat.append(hr)
    # hachimaki headband with a knot and two tails at the back
    stat.append(torus("headband", math.sqrt(R * R - 0.11 * 0.11) + 0.012, 0.04, (0, 0, H + 0.11), band, major=32, minor=10))
    stat.append(sphere("knot", 0.055, (0, R - 0.01, H + 0.13), band, scale=(1.2, 0.8, 0.9), segs=14))
    for s in (-1, 1):
        stat.append(box(f"tail{s}", (0.07, 0.025, 0.2), (s * 0.06, R + 0.03, H + 0.03), band, bevel=0.012, rot=(math.radians(-20), math.radians(s * 25), 0)))
    # face: oval eyes with a highlight, determined brows, cheeks, nose, a grin
    for s in (-1, 1):
        x = s * 0.095
        y = -math.sqrt(R * R - x * x) + 0.022
        stat.append(sphere(f"eye{s}", 0.05, (x, y, H), eye, scale=(0.75, 0.5, 1.2), segs=14))
        stat.append(sphere(f"hi{s}", 0.015, (x + 0.014, y - 0.024, H + 0.026), hi, segs=8))
        stat.append(box(f"brow{s}", (0.085, 0.03, 0.024), (x, y - 0.005, H + 0.085), hair, bevel=0.01, rot=(0, -s * 0.28, 0)))
        stat.append(sphere(f"cheek{s}", 0.045, (s * 0.165, -0.19, H - 0.065), cheek, scale=(1, 0.45, 0.7), segs=12))
    stat.append(sphere("nose", 0.026, (0, -R + 0.005, H - 0.03), mat("Nose", (1.0, 0.66, 0.5), rough=0.6), segs=12))
    mo = torus("mouth", 0.05, 0.014, (0, -0.258, H - 0.085), eye, rot=(math.radians(90), 0, 0), major=16, minor=6)
    cull(mo, lambda co: co.z < H - 0.085 - 0.01)
    stat.append(mo)
    body = join(stat, "torso")
    # hands with a cuff in the player's colour, and shoes: named, the game animates them
    limbs = []
    for x, side in ((-0.36, "L"), (0.36, "R")):
        h = sphere(f"hand{side}", 0.085, (x, -0.06, 0.45), skin, scale=(1, 0.95, 1.05), segs=16)
        cf = torus(f"cuff{side}", 0.06, 0.03, (x * 0.94, -0.04, 0.51), tint_d, rot=(0, math.radians(-x * 60), 0), major=16, minor=8)
        limbs.append(join([h, cf], f"hand{side}", origin=(x, -0.06, 0.45)))
    for x, side in ((-0.13, "L"), (0.13, "R")):
        limbs.append(sphere(f"foot{side}", 0.09, (x, -0.03, 0.055), shoe, scale=(0.95, 1.35, 0.62), segs=16))
    return [body] + limbs


def chef():
    reset()
    chef_parts()
    preview("chef", dist=2.0, height=0.7, target=(0, 0, 0.62))
    export("chef")
    # a lineup of the four rivals for review (not exported)
    reset()
    for k, c in enumerate([(0.89, 0.26, 0.23), (0.18, 0.56, 0.88), (0.95, 0.69, 0.2), (0.56, 0.36, 0.85)]):
        for o in chef_parts(c):
            o.location.x += (k - 1.5) * 0.85
    preview("chef_lineup", dist=3.2, height=0.9, target=(0.3, 0, 0.6), res=(800, 420))


# ---------- stations ----------

def anim(o):
    o["anim"] = 1
    return o


def station(name, extra, prev_target=(0, 0, 0.7)):
    reset()
    base = counter_base()
    more = extra() or []
    join(base + [o for o in more if not o.get("anim")], "base")
    preview(name, dist=2.4, height=1.5, target=prev_target)
    export(name)


def s_clear():
    return []


def s_board():
    bw = M_light()
    parts = [
        box("board", (0.62, 0.44, 0.05), (-0.04, 0.0, 0.94), bw, bevel=0.018),
        box("boardEdge", (0.6, 0.42, 0.012), (-0.04, 0.0, 0.912), mat("BoardEdge", (0.72, 0.52, 0.3), rough=0.75), bevel=0.004),
    ]
    # the knife: tip toward the chef, pivoting at the back of its handle so a chop swings the blade down
    blade = box("bladeSteel", (0.08, 0.3, 0.012), (0.375, -0.1, 0.915), M_steel(), bevel=0.004)
    for v in blade.data.vertices:  # a slanted tip
        if v.co.y < -0.1 and v.co.x < 0:
            v.co.x += 0.06
    hnd = cyl("knifeHandle", 0.026, 0.16, (0.395, 0.13, 0.924), mat("Handle", (0.12, 0.06, 0.04), rough=0.5), verts=10, rot=(math.radians(90), 0, 0), bevel=0.008)
    ring = cyl("ferrule", 0.029, 0.02, (0.395, 0.05, 0.924), M_brass(), verts=10, rot=(math.radians(90), 0, 0), bevel=0.004)
    knife = anim(join([blade, hnd, ring], "blade", origin=(0.395, 0.21, 0.924)))
    # a folded towel on the corner
    towel = box("towel", (0.18, 0.12, 0.03), (0.33, 0.36, 0.915), mat("Towel", (0.85, 0.88, 0.92), rough=0.9), bevel=0.012)
    stripe = box("towelStripe", (0.185, 0.03, 0.032), (0.33, 0.36, 0.916), mat("TowelStripe", INDIGO, rough=0.9), bevel=0.006)
    return parts + [towel, stripe, knife]


def s_cooker():
    body = mat("CookerBody", (0.95, 0.93, 0.88), rough=0.3)
    accent = mat("CookerAccent", (0.95, 0.42, 0.45), rough=0.4)
    panel = mat("Panel", (0.12, 0.12, 0.14), rough=0.3)
    parts = [
        cyl("cooker", 0.28, 0.27, (0, 0, 1.055), body, verts=36, bevel=0.06),
        torus("band", 0.282, 0.018, (0, 0, 1.11), accent, major=36, minor=8),
        box("panel", (0.18, 0.06, 0.1), (0, -0.26, 1.02), panel, bevel=0.02),
        sphere("light", 0.022, (0.045, -0.29, 1.03), M_glow(), segs=10),
        cyl("button", 0.025, 0.02, (-0.04, -0.29, 1.03), accent, verts=12, rot=(math.radians(90), 0, 0), bevel=0.005),
    ]
    for a in range(3):
        ang = a / 3 * math.tau + 0.5
        parts.append(cyl(f"foot{a}", 0.035, 0.03, (math.cos(ang) * 0.2, math.sin(ang) * 0.2, 0.915), panel, verts=10, bevel=0.008))
    # the lid (with its knob and steam vent): it rattles and jumps
    lid = sphere("lidDome", 0.27, (0, 0, 1.19), body, scale=(1, 1, 0.3), segs=32)
    cull(lid, lambda co: co.z >= 1.185)
    rim = torus("lidRim", 0.265, 0.02, (0, 0, 1.195), accent, major=36, minor=8)
    knob = sphere("lidKnob", 0.045, (0, 0, 1.27), M_wood_d(), scale=(1.4, 1, 0.7), segs=14)
    vent = cyl("vent", 0.025, 0.03, (0.12, 0.08, 1.25), M_steel(), verts=10, bevel=0.006)
    lidobj = anim(join([lid, rim, knob, vent], "lid", origin=(0, 0, 1.19)))
    # the rice paddle resting by the cooker
    pad = box("paddle", (0.08, 0.05, 0.012), (0.37, -0.32, 0.915), M_light(), bevel=0.006)
    stick = box("paddleStick", (0.025, 0.16, 0.01), (0.37, -0.2, 0.915), M_light(), bevel=0.004)
    return parts + [pad, stick, lidobj]


def burner():
    iron = mat("Iron", IRON, rough=0.45, metal=0.7)
    panel = mat("Panel", (0.12, 0.12, 0.14), rough=0.3)
    parts = [box("hob", (0.86, 0.86, 0.03), (0, 0, 0.91), mat("HobSteel", (0.3, 0.3, 0.33), rough=0.35, metal=0.8), bevel=0.012),
             cyl("ring", 0.15, 0.03, (0, 0, 0.93), iron, verts=24, bevel=0.008)]
    for a in range(4):
        ang = a / 4 * math.tau + math.pi / 4
        parts.append(box(f"grate{a}", (0.26, 0.035, 0.035), (math.cos(ang) * 0.22, math.sin(ang) * 0.22, 0.95), iron, bevel=0.008, rot=(0, 0, ang)))
    for x in (-0.3, 0.3):
        parts.append(cyl(f"dial{x}", 0.04, 0.035, (x, -0.5, 0.72), panel, verts=14, rot=(math.radians(90), 0, 0), bevel=0.01))
        parts.append(box(f"dialMark{x}", (0.01, 0.01, 0.04), (x, -0.52, 0.73), M_glow(), bevel=0.0))
    # the flame: a ring of blue tongues, origin at its base so scaling grows it upward
    fm = mat("Flame", (0.25, 0.55, 1.0), emit=8)
    tongues = [torus("flameRing", 0.13, 0.016, (0, 0, 0.95), fm, major=20, minor=6)]
    for a in range(10):
        ang = a / 10 * math.tau
        tongues.append(cone(f"tongue{a}", 0.028, 0.08, (math.cos(ang) * 0.13, math.sin(ang) * 0.13, 0.98), fm, verts=6))
    return parts + [anim(join(tongues, "flame", origin=(0, 0, 0.94)))]


def s_pan():
    parts = burner()
    panm = mat("PanIron", (0.1, 0.1, 0.11), rough=0.35, metal=0.85)
    pan = [
        cyl("panBody", 0.3, 0.05, (0, 0, 1.0), panm, verts=36, bevel=0.015, r2=0.27),
        cyl("panInside", 0.27, 0.01, (0, 0, 1.026), mat("PanInside", (0.2, 0.19, 0.2), rough=0.25, metal=0.9), verts=36, bevel=0.0),
        torus("panRim", 0.29, 0.016, (0, 0, 1.028), panm, major=36, minor=8),
        cyl("panNeck", 0.022, 0.12, (0, -0.33, 1.035), panm, verts=10, rot=(math.radians(80), 0, 0), bevel=0.006),
        cyl("panHandle", 0.03, 0.24, (0, -0.5, 1.06), mat("Handle", (0.12, 0.06, 0.04), rough=0.5), verts=12, rot=(math.radians(80), 0, 0), bevel=0.012),
    ]
    return parts + [anim(join(pan, "pan", origin=(0, 0, 1.0)))]


def s_pot():
    parts = burner()
    clay = mat("Clay", (0.42, 0.2, 0.12), rough=0.55)
    glaze = mat("ClayGlaze", (0.1, 0.1, 0.12), rough=0.25)
    parts += [
        cyl("pot", 0.26, 0.3, (0, 0, 1.12), clay, verts=36, bevel=0.04, r2=0.24),
        torus("potRim", 0.245, 0.03, (0, 0, 1.265), glaze, major=36, minor=8),
        torus("potBand", 0.262, 0.015, (0, 0, 1.06), glaze, major=36, minor=6),
    ]
    for x in (-0.29, 0.29):
        parts.append(torus(f"ear{x}", 0.05, 0.018, (x, 0, 1.22), glaze, rot=(math.radians(90), 0, 0), major=14, minor=6))
    broth = [cyl("brothTop", 0.235, 0.012, (0, 0, 1.272), mat("Broth", (0.42, 0.66, 0.2), rough=0.15), verts=36, bevel=0.0)]
    random.seed(3)
    for k in range(6):
        a, r = random.uniform(0, math.tau), random.uniform(0.03, 0.17)
        broth.append(sphere(f"bubble{k}", random.uniform(0.018, 0.03), (math.cos(a) * r, math.sin(a) * r, 1.28), mat("BrothLight", (0.62, 0.85, 0.32), rough=0.1), scale=(1, 1, 0.6), segs=10))
    ladle = cyl("ladleStick", 0.02, 0.4, (0.15, 0.1, 1.42), M_light(), verts=8, rot=(math.radians(-25), math.radians(20), 0), bevel=0.0)
    return parts + [ladle, anim(join(broth, "broth", origin=(0, 0, 1.272)))]


def s_plates():
    tray = M_wood_d()
    parts = [box("tray", (0.7, 0.62, 0.04), (0, 0, 0.92), tray, bevel=0.012),
             box("cloth", (0.5, 0.5, 0.012), (0, 0, 0.945), mat("Cloth", INDIGO, rough=0.95), bevel=0.004),
             box("clothStripe", (0.5, 0.05, 0.014), (0, 0.17, 0.946), mat("Crest", CREAM, rough=0.9), bevel=0.003)]
    for x in (-0.3, 0.3):
        for y in (-0.26, 0.26):
            parts.append(cyl(f"peg{x}{y}", 0.018, 0.12, (x, y, 0.99), tray, verts=8, bevel=0.005))
    # a soy-sauce bottle and a cup of chopsticks at the back
    parts.append(cyl("soy", 0.04, 0.12, (0.25, 0.25, 1.0), mat("Glass", (0.12, 0.05, 0.03), rough=0.1), verts=14, bevel=0.012))
    parts.append(cyl("soyCap", 0.025, 0.04, (0.25, 0.25, 1.08), mat("Cap", RED, rough=0.4), verts=12, bevel=0.008))
    parts.append(cyl("cup", 0.04, 0.09, (-0.26, 0.26, 0.98), mat("Clay", (0.42, 0.2, 0.12), rough=0.55), verts=14, bevel=0.01))
    for k in range(4):
        parts.append(cyl(f"stick{k}", 0.006, 0.2, (-0.26 + (k - 1.5) * 0.012, 0.26 + (k % 2) * 0.01, 1.06), M_light(), verts=6, bevel=0.0, rot=(0.05 * (k - 1.5), 0.08, 0)))
    return parts


def s_delivery():
    dark = M_wood_d()
    parts = [
        box("shelf", (0.98, 0.42, 0.05), (0, 0.2, 0.93), M_light(), bevel=0.015),
        box("postL", (0.07, 0.07, 0.6), (-0.46, 0.42, 1.2), dark, bevel=0.012),
        box("postR", (0.07, 0.07, 0.6), (0.46, 0.42, 1.2), dark, bevel=0.012),
        box("beam", (1.04, 0.09, 0.08), (0, 0.42, 1.52), dark, bevel=0.015),
        box("plaque", (0.46, 0.03, 0.12), (0, 0.37, 1.52), M_glow(), bevel=0.01),
        box("ticketRail", (0.7, 0.02, 0.02), (0, 0.36, 1.43), M_steel(), bevel=0.0),
    ]
    for k, x in enumerate((-0.22, 0.02, 0.24)):
        parts.append(box(f"ticket{k}", (0.12, 0.006, 0.15), (x, 0.355, 1.345), mat("Ticket", (0.98, 0.95, 0.86), rough=0.9), bevel=0.0, rot=(0, 0, 0.05 * (k - 1))))
    parts.append(box("bellBase", (0.16, 0.16, 0.025), (0.3, -0.25, 0.915), dark, bevel=0.008))
    dome = sphere("bellDome", 0.075, (0.3, -0.25, 0.94), M_brass(), scale=(1, 1, 0.75), segs=18)
    cull(dome, lambda co: co.z >= 0.938)
    top = sphere("bellTop", 0.018, (0.3, -0.25, 1.0), M_brass(), segs=10)
    return parts + [anim(join([dome, top], "bell", origin=(0.3, -0.25, 0.94)))]


def s_trash():
    bin_ = mat("Bin", (0.16, 0.36, 0.3), rough=0.45, metal=0.3)
    dark = mat("BinLid", (0.1, 0.22, 0.18), rough=0.4, metal=0.3)
    lid = sphere("binLid", 0.31, (0, 0, 1.36), dark, scale=(1, 1, 0.25), segs=24)
    cull(lid, lambda co: co.z >= 1.355)
    parts = [cyl("bin", 0.27, 0.46, (0, 0, 1.13), bin_, verts=28, bevel=0.03, r2=0.29), lid,
             box("lidHandle", (0.16, 0.04, 0.04), (0, 0, 1.44), M_steel(), bevel=0.012),
             box("pedal", (0.14, 0.12, 0.03), (0, -0.32, 0.92), M_steel(), bevel=0.01)]
    for z, r in ((0.96, 0.275), (1.3, 0.288)):
        parts.append(torus(f"hoop{z}", r, 0.018, (0, 0, z), dark, major=28, minor=6))
    return parts


def s_container():
    # an open slatted crate lined with straw; the ingredient sits on top at runtime
    wood = mat("Crate", (0.66, 0.46, 0.24), rough=0.85)
    dark = mat("CrateDark", (0.4, 0.25, 0.12), rough=0.85)
    parts = [box("floor", (0.7, 0.62, 0.04), (0, 0, 0.92), dark, bevel=0.0)]
    for z in (0.96, 1.06):
        for y in (-0.3, 0.3):
            parts.append(box(f"slatx{y}{z}", (0.72, 0.035, 0.07), (0, y, z), wood, bevel=0.01))
        for x in (-0.35, 0.35):
            parts.append(box(f"slaty{x}{z}", (0.035, 0.6, 0.07), (x, 0, z), wood, bevel=0.01))
    for x in (-0.35, 0.35):
        for y in (-0.3, 0.3):
            parts.append(box(f"corner{x}{y}", (0.06, 0.06, 0.2), (x, y, 1.0), dark, bevel=0.012))
    random.seed(11)
    straw = mat("Straw", (0.86, 0.72, 0.38), rough=0.95)
    for k in range(14):
        parts.append(box(f"straw{k}", (0.012, random.uniform(0.15, 0.3), 0.008), (random.uniform(-0.28, 0.28), random.uniform(-0.22, 0.22), 0.945), straw, bevel=0.0, rot=(0, 0, random.uniform(0, math.pi))))
    return parts


# ---------- stall dressing ----------

def lantern():
    reset()
    paper = mat("Paper", (1.0, 0.22, 0.08), rough=0.9, emit=0.6)
    p = sphere("paper", 0.25, (0, 0, 0), paper, scale=(1, 1, 1.25), segs=24)
    for v in p.data.vertices:  # the bamboo ribs show as ridges
        k = 1 + 0.035 * max(0, math.cos(v.co.z * 70))
        v.co.x *= k
        v.co.y *= k
    band = cyl("band", 0.255, 0.1, (0, 0, 0), mat("PaperBand", (0.08, 0.03, 0.03), rough=0.9), verts=24, bevel=0.0)
    caps = mat("LanternCap", DARK, rough=0.4)
    tas = mat("Tassel", (0.95, 0.75, 0.2), rough=0.6)
    parts = [p, band,
             cyl("capT", 0.13, 0.06, (0, 0, 0.3), caps, verts=18, bevel=0.015),
             cyl("capB", 0.13, 0.06, (0, 0, -0.3), caps, verts=18, bevel=0.015),
             cyl("string", 0.008, 0.5, (0, 0, 0.58), caps, verts=6, bevel=0.0),
             cyl("cord", 0.008, 0.12, (0, 0, -0.39), tas, verts=6, bevel=0.0),
             cyl("tassel", 0.012, 0.14, (0, 0, -0.5), tas, verts=10, bevel=0.0, r2=0.04)]
    join(parts, "lantern")
    preview("lantern", dist=1.6, height=0.3, target=(0, 0, 0))
    export("lantern")


def noren():
    reset()
    cloth = mat("Noren", INDIGO, rough=0.95)
    crest = mat("Crest", CREAM, rough=0.9)
    parts = [cyl("rod", 0.028, 3.4, (0, 0, 2.0), M_wood_d(), verts=12, rot=(0, math.radians(90), 0), bevel=0.0)]
    for x in (-1.72, 1.72):
        parts.append(sphere(f"end{x}", 0.045, (x, 0, 2.0), M_brass(), segs=10))
    n = 4
    w = 3.2 / n
    for k in range(n):
        x = -1.6 + w * (k + 0.5)
        bpy.ops.mesh.primitive_grid_add(x_subdivisions=10, y_subdivisions=6, size=1, location=(x, 0, 1.6))
        c = bpy.context.active_object
        c.name = f"cloth{k}"
        c.rotation_euler = (math.radians(90), 0, 0)
        c.scale = (w - 0.04, 0.78, 1)
        bpy.ops.object.transform_apply(rotation=True, scale=True)
        for v in c.data.vertices:  # gentle folds, deeper at the hem
            v.co.y += math.sin((v.co.x + x) * 9) * 0.02 * (1.0 + (0.39 - v.co.z) * 2)
        finish(c, cloth)
        c.modifiers.new("solid", "SOLIDIFY").thickness = 0.015
        parts.append(c)
    # a big crest across the middle panels: a cream circle with a red sun
    parts.append(cyl("crest", 0.3, 0.02, (0, -0.05, 1.62), crest, verts=32, rot=(math.radians(90), 0, 0), bevel=0.0))
    parts.append(cyl("sun", 0.16, 0.02, (0, -0.06, 1.62), mat("Sun", (0.85, 0.12, 0.08), rough=0.8), verts=28, rot=(math.radians(90), 0, 0), bevel=0.0))
    join(parts, "noren")
    preview("noren", dist=4.2, height=0.2, target=(0, 0, 1.6))
    export("noren")


def d_backwall():
    """The back of the stall: posts, a low plank wall, glowing shoji panels and a shelf of jars. 9 wide."""
    dark = M_wood_d()
    wood = mat("Wood", WOOD, rough=0.45)
    shoji = mat("Shoji", (1.0, 0.72, 0.42), rough=0.9, emit=0.3)
    parts = []
    for x in (-4.4, -1.5, 1.5, 4.4):
        parts.append(box(f"post{x}", (0.16, 0.16, 3.0), (x, 0.05, 1.5), dark, bevel=0.02))
    parts.append(box("planks", (8.9, 0.08, 1.3), (0, 0.1, 0.65), wood, bevel=0.01))
    for k in range(10):
        parts.append(box(f"seam{k}", (8.9, 0.09, 0.012), (0, 0.095, 0.12 + k * 0.13), dark, bevel=0.0))
    parts.append(box("rail", (8.9, 0.12, 0.08), (0, 0.06, 1.32), dark, bevel=0.015))
    parts.append(box("lintel", (9.1, 0.16, 0.14), (0, 0.04, 2.95), dark, bevel=0.02))
    # shoji: paper panels behind a lattice, lit from inside
    for cx in (-2.95, 2.95):
        parts.append(box(f"paper{cx}", (2.6, 0.02, 1.5), (cx, 0.14, 2.12), shoji, bevel=0.0))
        for k in range(5):
            parts.append(box(f"lv{cx}{k}", (0.03, 0.05, 1.5), (cx - 1.3 + k * 0.65, 0.11, 2.12), dark, bevel=0.0))
        for k in range(4):
            parts.append(box(f"lh{cx}{k}", (2.6, 0.05, 0.03), (cx, 0.11, 1.37 + k * 0.5), dark, bevel=0.0))
    # a shelf over the middle opening with jars and bottles
    parts.append(box("shelf", (2.8, 0.26, 0.05), (0, 0.0, 2.25), dark, bevel=0.01))
    random.seed(5)
    jar_cols = [(0.85, 0.82, 0.74), (0.42, 0.2, 0.12), (0.1, 0.12, 0.2), (0.75, 0.2, 0.12), (0.2, 0.35, 0.22)]
    x = -1.3
    while x < 1.1:
        r = random.uniform(0.06, 0.1)
        h = random.uniform(0.14, 0.32)
        ci = random.randrange(len(jar_cols))
        parts.append(cyl(f"jar{x:.2f}", r, h, (x + r, 0.0, 2.275 + h / 2), mat(f"Jar{ci}", jar_cols[ci], rough=0.3), verts=12, bevel=0.015))
        x += r * 2 + random.uniform(0.04, 0.12)
    return [join(parts, "backwallMesh")]


def d_sign():
    """A hanging signboard with a little roof; the chef's name is painted on at runtime (front face at y=-0.04)."""
    dark = M_wood_d()
    roof = mat("Roof", (0.16, 0.18, 0.22), rough=0.5)
    parts = [
        box("board", (2.3, 0.08, 0.6), (0, 0, 0), mat("SignBoard", (0.12, 0.06, 0.04), rough=0.5), bevel=0.02),
        box("frameT", (2.42, 0.12, 0.07), (0, 0, 0.32), dark, bevel=0.015),
        box("frameB", (2.42, 0.12, 0.07), (0, 0, -0.32), dark, bevel=0.015),
        box("roofL", (1.32, 0.42, 0.04), (-0.6, 0.0, 0.42), roof, bevel=0.01, rot=(0, math.radians(8), 0)),
        box("roofR", (1.32, 0.42, 0.04), (0.6, 0.0, 0.42), roof, bevel=0.01, rot=(0, math.radians(-8), 0)),
    ]
    return [join(parts, "signMesh")]


def d_post():
    """A front corner post with an arm to hang a lantern from (hook at x=+0.6, z=2.82)."""
    dark = M_wood_d()
    parts = [box("post", (0.14, 0.14, 2.95), (0, 0, 1.475), dark, bevel=0.02),
             box("foot", (0.24, 0.24, 0.12), (0, 0, 0.06), mat("Stone", STONE, rough=0.3), bevel=0.02),
             box("arm", (0.75, 0.07, 0.07), (0.3, 0, 2.86), dark, bevel=0.012),
             box("brace", (0.34, 0.05, 0.05), (0.13, 0, 2.7), dark, bevel=0.01, rot=(0, math.radians(-40), 0)),
             sphere("cap", 0.08, (0, 0, 2.98), M_brass(), scale=(1, 1, 0.6), segs=10)]
    return [join(parts, "postMesh")]


def d_stool():
    dark = M_wood_d()
    parts = [cyl("seat", 0.2, 0.06, (0, 0, 0.6), M_light(), verts=20, bevel=0.02),
             torus("ring", 0.14, 0.012, (0, 0, 0.25), dark, major=16, minor=6)]
    for a in range(3):
        ang = a / 3 * math.tau
        parts.append(cyl(f"leg{a}", 0.025, 0.6, (math.cos(ang) * 0.14, math.sin(ang) * 0.14, 0.3), dark, verts=8, bevel=0.0))
    return [join(parts, "stoolMesh")]


def d_crates():
    """A stack of produce crates for the street corners."""
    wood = mat("Crate", (0.66, 0.46, 0.24), rough=0.85)
    dark = mat("CrateDark", (0.4, 0.25, 0.12), rough=0.85)
    fruit = [(0.88, 0.12, 0.08), (0.95, 0.6, 0.1)]
    parts = []
    random.seed(9)
    for k, (cx, cy, z) in enumerate([(0, 0, 0), (0.64, 0.03, 0), (0.3, 0.0, 0.34)]):
        for zz in (0.08, 0.24):
            for s in (-1, 1):
                parts.append(box(f"c{k}x{s}{zz}", (0.6, 0.03, 0.12), (cx, cy + s * 0.2, z + zz), wood, bevel=0.008))
                parts.append(box(f"c{k}y{s}{zz}", (0.03, 0.4, 0.12), (cx + s * 0.29, cy, z + zz), wood, bevel=0.008))
        parts.append(box(f"c{k}floor", (0.58, 0.38, 0.03), (cx, cy, z + 0.03), dark, bevel=0.0))
        if k < 2:
            fm = mat(f"Fruit{k}", fruit[k], rough=0.35)
            for j in range(6):
                parts.append(sphere(f"f{k}{j}", 0.075, (cx + random.uniform(-0.18, 0.18), cy + random.uniform(-0.1, 0.1), z + 0.27), fm, segs=10))
    return [join(parts, "cratesMesh")]


def d_vent():
    """A round iron grate in the street; the game puffs steam out of it."""
    iron = mat("Iron", IRON, rough=0.45, metal=0.7)
    parts = [torus("rim", 0.4, 0.035, (0, 0, 0.02), iron, major=28, minor=6),
             cyl("hole", 0.38, 0.01, (0, 0, 0.008), mat("Hole", DARK, rough=1.0), verts=28, bevel=0.0)]
    for k in range(5):
        parts.append(box(f"bar{k}", (0.72 * math.sqrt(max(0.1, 1 - ((k - 2) * 0.13 / 0.38) ** 2)), 0.05, 0.035), (0, (k - 2) * 0.13, 0.02), iron, bevel=0.006))
    return [join(parts, "ventMesh")]


def d_barrel():
    wood = mat("Barrel", (0.5, 0.3, 0.15), rough=0.7)
    hoop = mat("Iron", IRON, rough=0.45, metal=0.7)
    b = cyl("barrel", 0.3, 0.7, (0, 0, 0.35), wood, verts=20, bevel=0.03)
    for v in b.data.vertices:
        k = 1 + 0.12 * math.cos(v.co.z / 0.35 * math.pi / 2)
        v.co.x *= k
        v.co.y *= k
    parts = [b, cyl("lid", 0.3, 0.03, (0, 0, 0.71), M_light(), verts=20, bevel=0.01)]
    for z in (0.12, 0.58):
        parts.append(torus(f"hoop{z}", 0.33, 0.018, (0, 0, z), hoop, major=24, minor=6))
    return [join(parts, "barrelMesh")]


def dressing():
    reset()
    items = [("backwall", d_backwall), ("sign", d_sign), ("post", d_post), ("stool", d_stool), ("crates", d_crates), ("vent", d_vent), ("barrel", d_barrel)]
    for name, fn in items:
        group(name, fn())
    export("dressing")
    # preview the set laid out (the export keeps every group at the origin)
    layout = {"backwall": (0, 3, 0), "sign": (0, 2.9, 3.5), "post": (-3, -1, 0), "stool": (-1.5, -1, 0), "crates": (0, -1, 0), "vent": (1.6, -1, 0), "barrel": (3, -1, 0)}
    for name, at in layout.items():
        bpy.data.objects[name].location = at
    preview("dressing", dist=6.5, height=3.0, target=(0, 1, 1.2), res=(960, 540), lens=30)


BUILDERS = {"chef": chef, "lantern": lantern, "noren": noren, "dressing": dressing}
for _n, _fn in [("counter", s_clear), ("board", s_board), ("cooker", s_cooker), ("pan", s_pan), ("pot", s_pot),
                ("plates", s_plates), ("delivery", s_delivery), ("trash", s_trash), ("container", s_container)]:
    BUILDERS[_n] = (lambda n, f: lambda: station(n, f))(_n, _fn)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for name in (argv or list(BUILDERS)):
        BUILDERS[name]()
    print("all assets built")
