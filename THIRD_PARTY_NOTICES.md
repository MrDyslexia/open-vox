# Third-Party Notices

This file covers the optional, inactive ONNX FP32 language-detector backend
(`scripts/narration_lid_onnx.py`, `src/narration-onnx-assets.ts`). It lists the
runtime dependency set pinned in `ONNX_PACKAGES` and the model the ONNX assets are
derived from.

Verification basis: license facts below were read from the `*.dist-info` metadata and
license files of the managed environment installed on the maintainer's machine
(`pn-venv/Lib/site-packages`, read-only). Anything that could not be confirmed from
those local files is marked **not verified locally** and must be confirmed against the
upstream project before a redistributed release.

These packages are installed into the user's environment by `pip` at setup time. They
are not vendored or redistributed by this repository.

## Runtime dependencies

| Package | Pinned | License (source of the statement) | Full license text below |
| --- | --- | --- | --- |
| kokoro-onnx | 0.6.1 | MIT (`licenses/LICENSE`) | Yes |
| onnxruntime | 1.31.0 | MIT (`METADATA`: `License: MIT License`, MIT classifier) | No: no license file ships in the local dist-info (not verified locally beyond metadata) |
| soundfile | 0.14.0 | BSD 3-Clause (`LICENSE`, `METADATA`) | Yes |
| numpy | 2.5.3 | `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` (`License-Expression`) | Main text only; bundled-component licenses are in the wheel's `licenses/` directory |
| tokenizers | 0.23.3 | Apache Software License (`METADATA` classifier only) | **No: the local dist-info contains no LICENSE file (not verified locally)** |

### tokenizers 0.23.3

The local `METADATA` carries only the classifier `License :: OSI Approved :: Apache
Software License` and the homepage `https://github.com/huggingface/tokenizers`. The
wheel's embedded CycloneDX SBOM lists the Rust dependency licenses but not the
project's own license text. **The full tokenizers LICENSE text is not available in any
local file inspected, so it is not reproduced here.** Before any redistribution, copy
the Apache-2.0 `LICENSE` file from the upstream `tokenizers` 0.23.3 source or sdist into
this section.

### kokoro-onnx 0.6.1

```
MIT License

Copyright (c) 2025 github.com/thewh1teagle

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### onnxruntime 1.31.0

Local metadata states `License: MIT License` (author: Microsoft Corporation, homepage
`https://onnxruntime.ai`). The license text itself and the upstream third-party notice
file are not present in the local dist-info (not verified locally). Add the upstream
MIT text and `ThirdPartyNotices.txt` before redistribution.

### soundfile 0.14.0

```
Copyright (c) 2013, Bastian Bechtold
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.
  * Neither the name of python-soundfile nor the names
    of its contributors may be used to endorse or promote products
    derived from this software without specific prior written
    permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

soundfile loads the system libsndfile through `cffi`; the bundled libsndfile binary
license is **not verified locally**.

### numpy 2.5.3

Declared expression: `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`. The main
NumPy license (first section of `licenses/LICENSE.txt`):

```
Copyright (c) 2005-2025, NumPy Developers.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
       copyright notice, this list of conditions and the following
       disclaimer in the documentation and/or other materials provided
       with the distribution.

    * Neither the name of the NumPy Developers nor the names of any
       contributors may be used to endorse or promote products derived
       from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Licenses of components bundled in the numpy wheel (for example Highway, libdivide,
pocketfft, x86-simd-sort, SVML, Dragon4, pythoncapi-compat and the random-number
sources) are shipped in that wheel's `licenses/` directory and are not reproduced here.

## Model: ONNX language-detector assets

- Derived from the Hugging Face checkpoint `sagorsarker/codeswitch-spaeng-lid-lince`,
  pinned to revision `66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c`
  (`resources/lid-model-onnx-fp32.json`, `derivedFrom`).
- `model.onnx` (FP32 graph) and the `tokenizer/*` files are derived from that pinned
  Hub revision. They are **not distributed in Git**. The graph has no download URL; it
  is copied from a local directory and verified by size and sha256 against the bundled
  manifest before it is published into the managed model directory.
- **The license of `sagorsarker/codeswitch-spaeng-lid-lince` is not verified locally.**
  No model card or license file for the checkpoint exists in the local files inspected
  (the local model directory holds only `config.json`, `model.safetensors`,
  `special_tokens_map.json`, `tokenizer_config.json` and `vocab.txt`). Confirm the
  license and any upstream-model terms (including those of the base model the
  checkpoint was fine-tuned from) on the Hub page for the pinned revision before
  distributing derived assets.
