import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))

import add_voices

SHAPE = add_voices.STYLE_SHAPE


def style(seed):
    return np.random.default_rng(seed).standard_normal(SHAPE).astype(np.float32)


class AddVoicesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.pack = self.dir / 'voices-v1.0.bin'
        self.voices = self.dir / 'voices'
        self.voices.mkdir()
        self.stock = {'em_alex': style(1), 'af_heart': style(2)}
        with open(self.pack, 'wb') as handle:
            np.savez(handle, **self.stock)

    def run_main(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = add_voices.main(['--pack', str(self.pack), '--voices-dir', str(self.voices)])
        return code, out.getvalue(), err.getvalue()

    def pack_keys(self):
        with np.load(self.pack, allow_pickle=False) as z:
            return {k: z[k] for k in z.files}

    def test_adds_a_new_voice_and_keeps_stock_voices_identical(self):
        np.save(self.voices / 'em_blocktype.npy', style(3))
        code, out, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn('em_blocktype', out)
        keys = self.pack_keys()
        self.assertEqual(set(keys), {'em_alex', 'af_heart', 'em_blocktype'})
        for name, array in self.stock.items():
            self.assertTrue(np.array_equal(keys[name], array))
        self.assertTrue(np.array_equal(keys['em_blocktype'], style(3)))
        self.assertEqual(keys['em_blocktype'].dtype, np.float32)

    def test_is_idempotent_and_leaves_the_pack_untouched(self):
        np.save(self.voices / 'em_blocktype.npy', style(3))
        self.assertEqual(self.run_main()[0], 0)
        before = self.pack.read_bytes()
        code, out, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn('already present', out)
        self.assertEqual(self.pack.read_bytes(), before)

    def test_updates_a_bundled_voice_that_changed(self):
        np.save(self.voices / 'em_blocktype.npy', style(3))
        self.run_main()
        np.save(self.voices / 'em_blocktype.npy', style(4))
        self.assertEqual(self.run_main()[0], 0)
        self.assertTrue(np.array_equal(self.pack_keys()['em_blocktype'], style(4)))

    def test_rejects_invalid_voices_without_touching_the_pack(self):
        before = self.pack.read_bytes()
        bad = {
            'em_blocktype': np.zeros((10, 1, 256), dtype=np.float32),   # wrong shape
            'em_float64': style(5).astype(np.float64),                  # wrong dtype
            'em_nan': np.full(SHAPE, np.nan, dtype=np.float32),         # non-finite
            'BadName': style(6),                                        # invalid id
        }
        for name, array in bad.items():
            with self.subTest(name=name):
                for old in self.voices.glob('*.npy'):
                    old.unlink()
                np.save(self.voices / f'{name}.npy', array)
                code, out, err = self.run_main()
                self.assertEqual(code, 2)
                self.assertIn('add_voices failed', err)
                self.assertEqual(self.pack.read_bytes(), before)

    def test_missing_pack_or_directory_fails(self):
        self.pack.unlink()
        self.assertEqual(self.run_main()[0], 2)
        with open(self.pack, 'wb') as handle:
            np.savez(handle, **self.stock)
        self.voices.rmdir()
        self.assertEqual(self.run_main()[0], 2)

    def test_leaves_no_temporary_files_behind(self):
        np.save(self.voices / 'em_blocktype.npy', style(3))
        self.run_main()
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ['voices', 'voices-v1.0.bin'])

    def test_shipped_voices_are_valid_style_arrays(self):
        shipped = add_voices.load_bundled(ROOT / 'resources' / 'voices')
        self.assertIn('em_blocktype', shipped)
        for name, array in shipped.items():
            self.assertEqual(array.shape, SHAPE, name)
            self.assertEqual(array.dtype, np.float32, name)
            self.assertTrue(name.startswith('e'), 'Spanish voices must start with e: ' + name)


if __name__ == '__main__':
    unittest.main()
