import tempfile
import unittest
from pathlib import Path

from PIL import Image

from agent.emoji_sticker_agent import make_white_background_transparent


class WhiteBackgroundTransparencyTests(unittest.TestCase):
    def test_preserves_white_enclosed_by_sticker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "sticker.png"
            image = Image.new("RGBA", (7, 7), "white")
            for x in range(2, 5):
                for y in range(2, 5):
                    image.putpixel((x, y), (20, 80, 160, 255))
            image.putpixel((3, 3), (255, 255, 255, 0))
            image.save(image_path)

            make_white_background_transparent(image_path)

            with Image.open(image_path) as result:
                self.assertEqual(result.getpixel((0, 0))[3], 0)
                self.assertEqual(result.getpixel((2, 2))[3], 255)
                self.assertEqual(result.getpixel((3, 3)), (255, 255, 255, 255))

    def test_fades_only_light_pixels_connected_to_canvas_edge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "sticker.png"
            image = Image.new("RGBA", (5, 5), "white")
            image.putpixel((1, 2), (235, 235, 235, 255))
            image.putpixel((2, 2), (100, 100, 100, 255))
            image.save(image_path)

            make_white_background_transparent(image_path)

            with Image.open(image_path) as result:
                self.assertEqual(result.getpixel((0, 2))[3], 0)
                self.assertEqual(result.getpixel((1, 2))[3], 128)
                self.assertEqual(result.getpixel((2, 2))[3], 255)


if __name__ == "__main__":
    unittest.main()
