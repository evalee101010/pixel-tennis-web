from pathlib import Path
from collections import deque
import sys

from PIL import Image


REGIONS = {
    "net": (0.0, 0.0, 1.0, 0.45),
    "joystick": (0.0, 0.42, 0.44, 1.0),
    "special": (0.28, 0.42, 0.72, 1.0),
    "hit": (0.58, 0.42, 1.0, 1.0),
}


MIN_ALPHA = 18


def alpha_bbox(image, pad=8):
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return None
    left, top, right, bottom = bbox
    return (
        max(0, left - pad),
        max(0, top - pad),
        min(image.width, right + pad),
        min(image.height, bottom + pad),
    )


def component_bboxes(image):
    alpha = image.getchannel("A")
    width, height = image.size
    pixels = alpha.load()
    visited = bytearray(width * height)
    boxes = []
    for y in range(height):
        for x in range(width):
            idx = y * width + x
            if visited[idx] or pixels[x, y] <= MIN_ALPHA:
                continue
            visited[idx] = 1
            queue = deque([(x, y)])
            left = right = x
            top = bottom = y
            area = 0
            while queue:
                cx, cy = queue.popleft()
                area += 1
                left = min(left, cx)
                right = max(right, cx)
                top = min(top, cy)
                bottom = max(bottom, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    nidx = ny * width + nx
                    if visited[nidx] or pixels[nx, ny] <= MIN_ALPHA:
                        continue
                    visited[nidx] = 1
                    queue.append((nx, ny))
            boxes.append((left, top, right + 1, bottom + 1, area))
    return boxes


def best_component_bbox(image, name, pad=8):
    boxes = component_bboxes(image)
    if not boxes:
        return None
    width, height = image.size
    cx = width / 2
    cy = height / 2
    candidates = []
    for left, top, right, bottom, area in boxes:
        bw = right - left
        bh = bottom - top
        if area < 140:
            continue
        if name == "net" and (bw < width * 0.45 or bh < 24):
            continue
        if name != "net" and (bw < 40 or bh < 40):
            continue
        center_x = (left + right) / 2
        center_y = (top + bottom) / 2
        center_penalty = abs(center_x - cx) * 0.5 + abs(center_y - cy) * 0.25
        score = area - center_penalty
        candidates.append((score, left, top, right, bottom, area))
    if not candidates:
        left, top, right, bottom, _ = max(boxes, key=lambda box: box[4])
    else:
        _, left, top, right, bottom, _ = max(candidates, key=lambda item: item[0])
    return (
        max(0, left - pad),
        max(0, top - pad),
        min(width, right + pad),
        min(height, bottom + pad),
    )


def slice_sheet(sheet_path, out_dir):
    sheet = Image.open(sheet_path).convert("RGBA")
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, region in REGIONS.items():
        rx1, ry1, rx2, ry2 = region
        crop_box = (
            int(sheet.width * rx1),
            int(sheet.height * ry1),
            int(sheet.width * rx2),
            int(sheet.height * ry2),
        )
        section = sheet.crop(crop_box)
        bbox = best_component_bbox(section, name)
        if not bbox:
            bbox = alpha_bbox(section)
        if not bbox:
            raise RuntimeError(f"No visible pixels found for {name} in {sheet_path}")
        asset = section.crop(bbox)
        asset.save(out_dir / f"{name}.png")
        print(f"{name}: {asset.width}x{asset.height}")


def main():
    if len(sys.argv) != 3:
        print("Usage: slice_ui_sheet.py <sheet.png> <out_dir>", file=sys.stderr)
        raise SystemExit(2)
    slice_sheet(Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == "__main__":
    main()
