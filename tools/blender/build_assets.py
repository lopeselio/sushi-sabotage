"""Builds every Sushi Sabotage 3D asset from code and exports .glb files.

Run headless:  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_assets.py
Outputs:       apps/web/public/models/*.glb and tools/blender/previews/*.png

Toy-like, chunky shapes with bevels; flat colours via named materials. Materials whose name starts
with "Tint" are recoloured per chef at runtime. No external textures or asset packs.
"""
import math
import os

import bpy
import bmesh  # noqa: F401  (kept for future mesh edits)

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


def finish(obj, m, bevel=0.0, segments=3, smooth=True):
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


def box(name, size, loc, m, bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, m, bevel)


def cyl(name, r, h, loc, m, verts=24, bevel=0.02, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return finish(o, m, bevel)


def sphere(name, r, loc, m, scale=(1, 1, 1), segs=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, radius=r, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, m)


def torus(name, R, r, loc, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc, rotation=rot, major_segments=32, minor_segments=12)
    o = bpy.context.active_object
    o.name = name
    return finish(o, m)


def export(name):
    # apply modifiers into the export; Y-up glTF
    path = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True, use_selection=False)
    print(f"exported {path} ({os.path.getsize(path) // 1024} KB)")


def preview(name, dist=3.2, height=1.6, target=(0, 0, 0.5)):
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_EEVEE_NEXT"
    scn.render.resolution_x = 480
    scn.render.resolution_y = 480
    scn.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.08, 0.06, 0.1, 1)
    scn.world = world
    bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
    sun = bpy.context.active_object
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(45), math.radians(10), math.radians(35))
    bpy.ops.object.light_add(type="POINT", location=(-2, -2, 2.5))
    bpy.context.active_object.data.energy = 250
    bpy.context.active_object.data.color = (1, 0.7, 0.4)
    bpy.ops.object.camera_add(location=(dist * 0.8, -dist, height + target[2]))
    cam = bpy.context.active_object
    direction = (target[0] - cam.location[0], target[1] - cam.location[1], target[2] - cam.location[2])
    cam.rotation_euler = (math.atan2(math.hypot(direction[0], direction[1]), -direction[2]), 0, math.atan2(direction[1], direction[0]) - math.pi / 2)
    scn.camera = cam
    scn.render.filepath = os.path.join(PREV, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    # don't export preview rig
    for o in [o for o in bpy.data.objects if o.type in ("LIGHT", "CAMERA")]:
        bpy.data.objects.remove(o, do_unlink=True)


# ---------- palette ----------

WOOD = (0.42, 0.24, 0.12)
WOOD_D = (0.25, 0.13, 0.07)
STONE = (0.78, 0.76, 0.72)
STEEL = (0.6, 0.62, 0.66)
DARK = (0.08, 0.07, 0.09)
RED = (0.75, 0.12, 0.1)
CREAM = (0.95, 0.9, 0.8)
SKIN = (0.96, 0.78, 0.62)


def counter_base():
    """The shared counter body: wooden cabinet with a stone top, 1x1 cell, 0.9 tall."""
    box("cabinet", (0.96, 0.96, 0.8), (0, 0, 0.4), mat("Wood", WOOD), bevel=0.04)
    box("kick", (0.9, 0.9, 0.08), (0, 0, 0.04), mat("WoodDark", WOOD_D), bevel=0.01)
    box("top", (1.0, 1.0, 0.1), (0, 0, 0.85), mat("Stone", STONE, rough=0.35), bevel=0.03)
    for x in (-0.24, 0.24):
        box(f"door{x}", (0.42, 0.02, 0.55), (x, -0.485, 0.42), mat("WoodDark", WOOD_D), bevel=0.01)


# ---------- assets ----------

def chef():
    reset()
    tint = mat("Tint", (0.9, 0.3, 0.2), rough=0.55)
    sphere("body", 0.3, (0, 0, 0.42), tint, scale=(1, 0.9, 1.15))
    box("apron", (0.36, 0.06, 0.38), (0, -0.255, 0.36), mat("Apron", CREAM), bevel=0.025)
    sphere("head", 0.24, (0, 0, 0.93), mat("Skin", SKIN, rough=0.7))
    torus("band", 0.22, 0.045, (0, 0, 1.03), mat("TintBand", (0.9, 0.3, 0.2)))
    box("knot", (0.08, 0.06, 0.08), (0.0, 0.23, 1.03), mat("TintBand", (0.9, 0.3, 0.2)), bevel=0.02)
    for x in (-0.085, 0.085):
        sphere(f"eye{x}", 0.03, (x, -0.215, 0.95), mat("Eye", DARK, rough=0.2))
    sphere("cheekL", 0.035, (-0.14, -0.19, 0.88), mat("Cheek", (0.95, 0.5, 0.45)))
    sphere("cheekR", 0.035, (0.14, -0.19, 0.88), mat("Cheek", (0.95, 0.5, 0.45)))
    # named so the game can animate them (walk, carry, chop)
    for x, side in ((-0.33, "L"), (0.33, "R")):
        sphere(f"hand{side}", 0.08, (x, -0.1, 0.5), mat("Skin", SKIN, rough=0.7))
    for x, side in ((-0.12, "L"), (0.12, "R")):
        cyl(f"foot{side}", 0.08, 0.1, (x, 0, 0.05), mat("Shoe", DARK), verts=16)
    preview("chef", dist=2.4, height=0.9, target=(0, 0, 0.6))
    export("chef")


def station(name, extra, prev_target=(0, 0, 0.7)):
    reset()
    counter_base()
    extra()
    preview(name, dist=2.6, height=1.4, target=prev_target)
    export(name)


def s_clear():
    pass


def s_board():
    box("board", (0.62, 0.42, 0.06), (0, 0, 0.93), mat("BoardWood", (0.85, 0.66, 0.42), rough=0.8), bevel=0.02)
    box("blade", (0.04, 0.3, 0.02), (0.36, 0.05, 0.92), mat("Steel", STEEL, rough=0.25, metal=0.9), bevel=0.005)
    box("handle", (0.05, 0.12, 0.04), (0.36, -0.15, 0.92), mat("WoodDark", WOOD_D), bevel=0.01)


def s_cooker():
    cyl("cooker", 0.3, 0.32, (0, 0, 1.06), mat("CookerBody", (0.93, 0.93, 0.9), rough=0.3), verts=32, bevel=0.05)
    cyl("lid", 0.27, 0.06, (0, 0, 1.25), mat("CookerLid", (0.85, 0.25, 0.2), rough=0.4), verts=32, bevel=0.03)
    sphere("knob", 0.05, (0, 0, 1.3), mat("WoodDark", WOOD_D))
    box("panel", (0.16, 0.04, 0.1), (0, -0.3, 1.02), mat("Panel", DARK), bevel=0.01)
    sphere("light", 0.022, (0.04, -0.33, 1.03), mat("Glow", (1, 0.6, 0.1), emit=4))


def s_pan():
    box("burner", (0.8, 0.8, 0.04), (0, 0, 0.92), mat("Iron", (0.15, 0.15, 0.17), rough=0.5, metal=0.6), bevel=0.01)
    torus("flame", 0.18, 0.025, (0, 0, 0.95), mat("Flame", (0.2, 0.5, 1.0), emit=5))
    cyl("pan", 0.3, 0.06, (0, 0, 1.0), mat("PanIron", (0.12, 0.12, 0.14), rough=0.35, metal=0.8), verts=32, bevel=0.02)
    cyl("handle", 0.03, 0.36, (0, -0.47, 1.02), mat("WoodDark", WOOD_D), verts=12, rot=(math.radians(90), 0, 0))


def s_pot():
    box("burner", (0.8, 0.8, 0.04), (0, 0, 0.92), mat("Iron", (0.15, 0.15, 0.17), rough=0.5, metal=0.6), bevel=0.01)
    cyl("pot", 0.27, 0.34, (0, 0, 1.12), mat("Copper", (0.72, 0.38, 0.2), rough=0.3, metal=0.9), verts=32, bevel=0.03)
    cyl("broth", 0.25, 0.02, (0, 0, 1.28), mat("Broth", (0.45, 0.7, 0.25), rough=0.2), verts=32, bevel=0.0)
    for x in (-0.3, 0.3):
        box(f"ear{x}", (0.08, 0.06, 0.04), (x, 0, 1.24), mat("Copper", (0.72, 0.38, 0.2), rough=0.3, metal=0.9), bevel=0.01)


def s_plates():
    box("rack", (0.7, 0.5, 0.06), (0, 0, 0.93), mat("WoodDark", WOOD_D), bevel=0.02)
    for k in range(3):
        cyl(f"plate{k}", 0.26, 0.03, (0, 0, 0.98 + k * 0.035), mat("Porcelain", (0.97, 0.97, 0.95), rough=0.2), verts=32, bevel=0.01)


def s_delivery():
    box("hatch", (0.96, 0.2, 0.7), (0, 0.4, 1.25), mat("WoodDark", WOOD_D), bevel=0.03)
    box("bell_base", (0.18, 0.18, 0.03), (0.25, -0.2, 0.92), mat("WoodDark", WOOD_D), bevel=0.01)
    sphere("bell", 0.08, (0.25, -0.2, 0.98), mat("Brass", (0.85, 0.65, 0.2), rough=0.25, metal=1.0), scale=(1, 1, 0.7))
    box("sign", (0.6, 0.04, 0.22), (0, 0.29, 1.45), mat("Glow", (1, 0.6, 0.1), emit=3), bevel=0.01)


def s_trash():
    cyl("bin", 0.3, 0.5, (0, 0, 1.1), mat("Bin", (0.2, 0.32, 0.25), rough=0.6), verts=24, bevel=0.03)
    cyl("lid", 0.32, 0.05, (0, 0, 1.37), mat("BinLid", (0.15, 0.22, 0.17)), verts=24, bevel=0.02)


def s_container():
    # an open wooden crate on the counter; the ingredient is shown on top at runtime
    wood = mat("Crate", (0.6, 0.42, 0.22), rough=0.85)
    box("floor", (0.7, 0.6, 0.04), (0, 0, 0.92), mat("CrateIn", (0.3, 0.2, 0.1)), bevel=0.0)
    for y in (-0.28, 0.28):
        box(f"wallx{y}", (0.7, 0.04, 0.2), (0, y, 1.0), wood, bevel=0.01)
    for x in (-0.33, 0.33):
        box(f"wally{x}", (0.04, 0.6, 0.2), (x, 0, 1.0), wood, bevel=0.01)


def lantern():
    reset()
    m = mat("Paper", (1.0, 0.45, 0.25), rough=0.9, emit=6)
    sphere("paper", 0.25, (0, 0, 0), m, scale=(1, 1, 1.25))
    for z in (-0.3, 0.3):
        cyl(f"cap{z}", 0.12, 0.05, (0, 0, z), mat("LanternCap", DARK), verts=16)
    cyl("string", 0.008, 0.5, (0, 0, 0.55), mat("LanternCap", DARK), verts=6)
    preview("lantern", dist=1.6, height=0.4, target=(0, 0, 0))
    export("lantern")


def noren():
    reset()
    cyl("rod", 0.025, 2.4, (0, 0, 2.0), mat("WoodDark", WOOD_D), verts=12, rot=(0, math.radians(90), 0))
    for k, x in enumerate((-0.8, 0, 0.8)):
        box(f"cloth{k}", (0.74, 0.02, 0.7), (x, 0, 1.62), mat("Noren", (0.12, 0.16, 0.38), rough=0.95), bevel=0.0)
        sphere(f"crest{k}", 0.12, (x, -0.02, 1.62), mat("Crest", (0.95, 0.92, 0.85)), scale=(1, 0.1, 1))
    preview("noren", dist=3.4, height=0.2, target=(0, 0, 1.6))
    export("noren")


if __name__ == "__main__":
    chef()
    for name, fn in [("counter", s_clear), ("board", s_board), ("cooker", s_cooker), ("pan", s_pan), ("pot", s_pot),
                     ("plates", s_plates), ("delivery", s_delivery), ("trash", s_trash), ("container", s_container)]:
        station(name, fn)
    lantern()
    noren()
    print("all assets built")
