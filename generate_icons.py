#!/usr/bin/env python3
"""
生成 ReShelf Chrome 扩展的临时图标
使用 Pillow 库生成不同尺寸的纯色图标
"""

from PIL import Image, ImageDraw
import os

def generate_icon(size, output_path):
    """
    生成指定尺寸的图标
    
    Args:
        size: 图标尺寸（宽度和高度）
        output_path: 输出文件路径
    """
    # 创建新图片，使用 RGBA 模式以支持透明度
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 使用与 UI 一致的渐变色（紫色系）
    # 主色：#667eea (RGB: 102, 126, 234)
    # 或者使用纯色：#764ba2 (RGB: 118, 75, 162)
    
    # 使用渐变色的中间值作为纯色
    color = (102, 126, 234)  # #667eea
    
    # 绘制圆角矩形（如果尺寸足够大）
    if size >= 48:
        # 计算圆角半径（约为尺寸的 20%）
        corner_radius = int(size * 0.2)
        
        # 绘制圆角矩形
        draw.rounded_rectangle(
            [(0, 0), (size - 1, size - 1)],
            radius=corner_radius,
            fill=color
        )
        
        # 添加简单的 "R" 字母标识（仅在大尺寸图标上）
        if size >= 48:
            try:
                from PIL import ImageFont
                # 尝试使用系统字体
                font_size = int(size * 0.6)
                try:
                    # macOS
                    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
                except:
                    try:
                        # Linux
                        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
                    except:
                        # Windows 或默认
                        font = ImageFont.load_default()
            except:
                font = ImageFont.load_default()
            
            # 绘制白色 "R" 字母
            text = "R"
            bbox = draw.textbbox((0, 0), text, font=font)
            text_width = bbox[2] - bbox[0]
            text_height = bbox[3] - bbox[1]
            
            position = ((size - text_width) // 2, (size - text_height) // 2)
            draw.text(position, text, fill=(255, 255, 255, 255), font=font)
    else:
        # 小尺寸图标，直接填充纯色
        draw.rectangle([(0, 0), (size - 1, size - 1)], fill=color)
    
    # 保存图片
    img.save(output_path, 'PNG')
    print(f"✓ 已生成图标: {output_path} ({size}x{size})")

def main():
    """主函数"""
    # 创建 icons 目录（如果不存在）
    icons_dir = 'icons'
    os.makedirs(icons_dir, exist_ok=True)
    
    # 定义要生成的图标尺寸
    sizes = [
        (16, 'icon16.png'),
        (48, 'icon48.png'),
        (128, 'icon128.png')
    ]
    
    print("开始生成 ReShelf 图标...")
    print("-" * 40)
    
    # 生成所有尺寸的图标
    for size, filename in sizes:
        output_path = os.path.join(icons_dir, filename)
        generate_icon(size, output_path)
    
    print("-" * 40)
    print("✓ 所有图标生成完成！")
    print(f"图标保存在: {os.path.abspath(icons_dir)}/")

if __name__ == '__main__':
    main()
