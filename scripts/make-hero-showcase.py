import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

REPO_ROOT = Path(r"C:\Users\Public\cwdev\cloakwire-release-v132")
SCREENS_DIR = Path(r"C:\Users\Алексей\Desktop\screens")
OUT_DIR = REPO_ROOT / "dist-release" / "screenshots"
OUT_DIR.mkdir(parents=True, exist_ok=True)

def add_rounded_corners_and_border(img, radius=20, border_width=1, border_color=(60, 60, 68, 255)):
    # Add alpha mask for rounded corners
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (w, h)], radius=radius, fill=255)
    
    rounded = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rounded.paste(img, (0, 0), mask=mask)
    
    # Draw border
    border_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(border_img)
    bdraw.rounded_rectangle([(0, 0), (w-1, h-1)], radius=radius, outline=border_color, width=border_width)
    
    return Image.alpha_composite(rounded, border_img)

def create_drop_shadow(img, offset=(0, 20), blur_radius=30, shadow_color=(0, 0, 0, 180)):
    w, h = img.size
    pad = blur_radius * 2 + max(abs(offset[0]), abs(offset[1])) + 20
    
    shadow_canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    
    # Create solid mask from image alpha
    alpha = img.split()[-1]
    shadow_mask = Image.new("L", img.size, 0)
    shadow_mask.paste(alpha, (0, 0))
    
    # Tint shadow
    solid_shadow = Image.new("RGBA", img.size, shadow_color)
    
    # Place on padded canvas
    sx = pad + offset[0]
    sy = pad + offset[1]
    shadow_canvas.paste(solid_shadow, (sx, sy), mask=shadow_mask)
    
    # Blur
    shadow_blurred = shadow_canvas.filter(ImageFilter.GaussianBlur(blur_radius))
    
    # Paste actual image over blurred shadow
    shadow_blurred.paste(img, (pad, pad), mask=img)
    
    return shadow_blurred, pad

def make_hero_stacked(home_p, servers_p, routing_p, config_p, out_p):
    W, H = 1800, 1020
    # Background: modern dark mesh / subtle gradient
    bg = Image.new("RGB", (W, H), (8, 9, 12))
    draw = ImageDraw.Draw(bg)
    
    # Subtle radial glow in the center top
    for r in range(450, 0, -10):
        alpha = int(18 * (1 - r / 450))
        glow_color = (25 + alpha, 28 + alpha, 38 + alpha)
        draw.ellipse([(W//2 - r, H//2 - r - 100), (W//2 + r, H//2 + r - 100)], fill=glow_color)
    
    bg = bg.convert("RGBA")
    
    # Load images
    im_home = Image.open(home_p).convert("RGBA")
    im_servers = Image.open(servers_p).convert("RGBA")
    im_routing = Image.open(routing_p).convert("RGBA")
    
    # Prepare Left (Servers) window - scaled and dimmed slightly
    s_scale = 0.76
    im_s_scaled = im_servers.resize((int(im_servers.width * s_scale), int(im_servers.height * s_scale)), Image.Resampling.LANCZOS)
    im_s_prep = add_rounded_corners_and_border(im_s_scaled, radius=16, border_color=(45, 45, 52, 255))
    im_s_shadow, pad_s = create_drop_shadow(im_s_prep, offset=(0, 24), blur_radius=32, shadow_color=(0, 0, 0, 190))
    
    # Prepare Right (Routing) window
    r_scale = 0.76
    im_r_scaled = im_routing.resize((int(im_routing.width * r_scale), int(im_routing.height * r_scale)), Image.Resampling.LANCZOS)
    im_r_prep = add_rounded_corners_and_border(im_r_scaled, radius=16, border_color=(45, 45, 52, 255))
    im_r_shadow, pad_r = create_drop_shadow(im_r_prep, offset=(0, 24), blur_radius=32, shadow_color=(0, 0, 0, 190))
    
    # Prepare Center (Home) window - primary focal point
    h_scale = 0.88
    im_h_scaled = im_home.resize((int(im_home.width * h_scale), int(im_home.height * h_scale)), Image.Resampling.LANCZOS)
    im_h_prep = add_rounded_corners_and_border(im_h_scaled, radius=18, border_color=(75, 75, 88, 255))
    im_h_shadow, pad_h = create_drop_shadow(im_h_prep, offset=(0, 32), blur_radius=44, shadow_color=(0, 0, 0, 220))
    
    # Composite Left
    left_x = int(W * 0.03) - pad_s
    left_y = int(H * 0.20) - pad_s
    bg.paste(im_s_shadow, (left_x, left_y), mask=im_s_shadow)
    
    # Composite Right
    right_x = int(W * 0.97 - im_r_prep.width) - pad_r
    right_y = int(H * 0.20) - pad_r
    bg.paste(im_r_shadow, (right_x, right_y), mask=im_r_shadow)
    
    # Composite Center (Home) on top
    center_x = (W - im_h_prep.width) // 2 - pad_h
    center_y = int(H * 0.12) - pad_h
    bg.paste(im_h_shadow, (center_x, center_y), mask=im_h_shadow)
    
    # Convert and save
    final_img = bg.convert("RGB")
    final_img.save(out_p, "PNG", optimize=True)
    print(f"Saved hero showcase to {out_p}")

def main():
    home_p = SCREENS_DIR / "Home.png"
    servers_p = SCREENS_DIR / "Servers.png"
    routing_p = SCREENS_DIR / "Routing.png"
    config_p = SCREENS_DIR / "Config.png"
    
    # 1. Update individual section screenshots
    Image.open(home_p).save(OUT_DIR / "01-home.png", "PNG", optimize=True)
    Image.open(servers_p).save(OUT_DIR / "02-servers.png", "PNG", optimize=True)
    Image.open(config_p).save(OUT_DIR / "03-config.png", "PNG", optimize=True)
    Image.open(routing_p).save(OUT_DIR / "04-routing.png", "PNG", optimize=True)
    print("Updated 01-home.png, 02-servers.png, 03-config.png, 04-routing.png")
    
    # 2. Generate hero showcase
    hero_out = OUT_DIR / "hero-showcase.png"
    make_hero_stacked(home_p, servers_p, routing_p, config_p, hero_out)

if __name__ == "__main__":
    main()
