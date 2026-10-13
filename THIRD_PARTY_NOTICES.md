# Third-Party Notices

This file covers the optional, inactive ONNX FP32 language-detector backend
(`scripts/narration_lid_onnx.py`, `src/narration-onnx-assets.ts`). It lists the
runtime dependency set pinned in `ONNX_PACKAGES` and the model the ONNX assets are
derived from.

Verification basis: every statement below names its source. Local sources are paths
relative to `%LOCALAPPDATA%\open-vox\pn-onnx-venv\Lib\site-packages` (the dedicated
ONNX environment on the maintainer's machine, read-only; the torch `pn-venv`
carries identical dist-info for the shared packages). Remote sources are official
upstream URLs fetched read-only on 2026-10-13. Anything that could not be confirmed
from a named source is marked **not verified**, with the reason.

These packages are installed into the user's environment by `pip` at setup time. They
are not vendored or redistributed by this repository.

## Runtime dependencies

| Package | Pinned | License | Source of the statement | Full text below |
| --- | --- | --- | --- | --- |
| kokoro-onnx | 0.6.1 | MIT | `kokoro_onnx-0.6.1.dist-info/licenses/LICENSE` | Yes |
| onnxruntime | 1.31.0 | MIT | `onnxruntime/LICENSE` (package dir) and `onnxruntime-1.31.0.dist-info/METADATA` | Yes |
| soundfile | 0.14.0 | BSD 3-Clause | `soundfile-0.14.0.dist-info/LICENSE`, `METADATA` | Yes |
| libsndfile (bundled in the soundfile wheel) | not recorded | LGPL-2.1 text | `_soundfile_data/COPYING` (SHA-256 `AD01EA5CD2755F6048383C8D54C88459CD6FCB17757C5C8892F8C5EA060F6140`) | Pointer only (see below) |
| numpy | 2.5.3 | `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` | `numpy-2.5.3.dist-info/METADATA` (`License-Expression`) | Main text only; bundled-component licenses are in `numpy-2.5.3.dist-info/licenses/` |
| tokenizers | 0.23.3 | Apache-2.0 | `METADATA` classifier (local); LICENSE text from upstream `https://raw.githubusercontent.com/huggingface/tokenizers/v0.23.3/LICENSE` (tag `v0.23.3`) | Yes (Apache-2.0 text below) |

The tokenizers 0.23.3 wheel installed locally ships no LICENSE file (neither in
`tokenizers-0.23.3.dist-info` nor in `tokenizers/`); only a CycloneDX SBOM and the
Apache classifier are present. That is why the text below comes from the upstream tag.

### Transitive dependencies of kokoro-onnx (not in `ONNX_PACKAGES`)

`kokoro_onnx-0.6.1.dist-info/METADATA` requires `espeakng-loader>=0.2.4` and
`phonemizer>=3.4.0`, so a default `pip install kokoro-onnx` pulls them in next to the
five pinned packages.

- phonemizer 3.4.0: `GNU General Public License v3 or later (GPLv3+)`
  (`phonemizer-3.4.0.dist-info/METADATA` and `licenses/LICENSE`, 35142 bytes).
- espeakng-loader 0.2.4: ships `espeakng_loader/espeak-ng.dll`. Its dist-info has no
  license metadata and no license file, and the espeak-ng license was not fetched, so
  the license of this binary is **not verified**.

Both are outside the five-package pin and their texts are not reproduced here. If the
environment is ever redistributed (not only installed by `pip` on the user's machine),
resolve these two licenses first. Their applicability to the integration is also
unresolved; local installation alone is not a legal clearance.

### tokenizers 0.23.3

License: Apache License 2.0. Source of the text below: upstream
`https://raw.githubusercontent.com/huggingface/tokenizers/v0.23.3/LICENSE` (git tag
`v0.23.3`, fetched read-only on 2026-10-13; unmodified, it contains the unfilled
Appendix boilerplate `Copyright [yyyy] [name of copyright owner]`). This is the single
Apache-2.0 text of this file; any other Apache-2.0 component referred to in this
document uses the same terms.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

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

`onnxruntime-1.31.0.dist-info/METADATA` states `License: MIT License` (author:
Microsoft Corporation). The dist-info has no license file, but the installed package
directory does: `onnxruntime/LICENSE` (1094 bytes), reproduced verbatim below, and
`onnxruntime/ThirdPartyNotices.txt` (344457 bytes, "THIRD PARTY SOFTWARE NOTICES AND
INFORMATION"), which covers the third-party code compiled into the binary. The latter
is too large to inline; ship it next to the wheel's files if the environment is ever
redistributed. Not compared against the upstream `microsoft/onnxruntime` repository.

```
MIT License

Copyright (c) Microsoft Corporation

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

#### libsndfile bundled in the soundfile wheel

soundfile talks to libsndfile through `cffi`. On Windows the wheel bundles the binary
`_soundfile_data/libsndfile_x64.dll` (2364416 bytes, loaded dynamically at run time;
`soundfile.py` selects `_packaged_libname = 'libsndfile_x64.dll'`) and ships the license
text next to it as `_soundfile_data/COPYING`, which starts with "GNU LESSER GENERAL
PUBLIC LICENSE Version 2.1, February 1999" (26518 bytes, SHA-256 in the table above).
The LGPL-2.1 text is not reproduced here; it is the verbatim `COPYING` file of the
installed wheel, and it must travel with the DLL if the environment is redistributed.
The libsndfile version and its own bundled codec licenses were not extracted from the
DLL: **not verified**. This repository does not link libsndfile; the user's `pip`
installs the wheel, and the library stays a separate, replaceable DLL.

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
- Declared license of `sagorsarker/codeswitch-spaeng-lid-lince`: `license: mit` in the
  README front matter at the pinned revision
  (`https://huggingface.co/sagorsarker/codeswitch-spaeng-lid-lince/resolve/66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c/README.md`)
  and in the Hub API record for the same revision
  (`https://huggingface.co/api/models/sagorsarker/codeswitch-spaeng-lid-lince/revision/66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c`,
  tag `license:mit`, `lastModified` 2023-03-27). Fetched read-only on 2026-10-13.
- **Gaps, stated plainly.** The repository at that revision has no LICENSE file (files:
  `README.md`, `config.json`, `eval_results.txt`, `flax_model.msgpack`,
  `model.safetensors`, `pytorch_model.bin`, `special_tokens_map.json`,
  `test_predictions.txt`, `test_results.txt`, `tokenizer_config.json`,
  `training_args.bin`, `vocab.txt`), so there is no copyright holder line or license
  text to reproduce: the MIT claim is a metadata tag only. The model card does not
  name the base model. The architecture (`BertForTokenClassification`, vocab size
  119547, 12 layers, hidden size 768) and the config match
  `google-bert/bert-base-multilingual-cased`, which is `license: apache-2.0`
  (`https://huggingface.co/api/models/google-bert/bert-base-multilingual-cased`,
  fetched 2026-10-13); that match is an inference from the config, not a statement by
  the checkpoint author. The card cites the LinCE dataset
  (`https://ritual.uh.edu/lince/home`) as training data and its terms were not
  checked. The ONNX graph and the tokenizer files are conversions of this checkpoint,
  so they inherit whatever terms apply to it.
- **Redistribution warning.** Do not redistribute `model.onnx` or the derived
  `tokenizer/*` files (in a release, installer, bundle or public mirror) until the
  owner has confirmed the licensing chain above (checkpoint author MIT claim without a
  license file, probable Apache-2.0 base model, LinCE dataset terms) and added the
  required attribution. This repository never ships these assets in Git; the user
  copies them from a local source with `open-vox setup narration-onnx --lid-source`.

## Open items

- Owner confirmation of the model licensing chain (see warning above).
- Licenses of `espeakng-loader` (espeak-ng.dll) and the libsndfile build: not verified.
- `phonemizer` is GPL-3.0-or-later (transitive of kokoro-onnx); its applicability to this integration remains unresolved. Installation by the user
  does not establish that GPL obligations are inapplicable; no legal assurance is made.
- Include `onnxruntime/ThirdPartyNotices.txt` and `_soundfile_data/COPYING` with any
  redistributed environment.
