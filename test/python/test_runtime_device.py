"""Model-free runtime policy tests; all native dependencies are injected."""
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import runtime_device as device

CPU = 'CPUExecutionProvider'
CUDA = 'CUDAExecutionProvider'


def session(providers):
    return SimpleNamespace(get_providers=lambda: providers, disable_fallback=Mock())


class RuntimeDeviceTests(unittest.TestCase):
    def test_managed_preload_failure_blocks_cuda_before_provider_enumeration(self):
        ort = SimpleNamespace(get_available_providers=Mock(return_value=[CUDA, CPU]))
        with patch.object(device, 'preload_for_worker', return_value=False, create=True):
            self.assertFalse(device.probe_runtime(ort=ort, driver_probe=lambda: True).ort_cuda)
        ort.get_available_providers.assert_not_called()

    def test_cpu_provider_skips_driver_and_torch(self):
        driver = Mock(side_effect=AssertionError('must not probe'))
        ort = SimpleNamespace(get_available_providers=lambda: [CPU])
        with patch.dict(sys.modules, {'torch': None}):
            result = device.probe_runtime(ort=ort, driver_probe=driver)
        self.assertEqual(result, device.RuntimeDevice())
        driver.assert_not_called()

    def test_advertisement_requires_working_driver_device(self):
        ort = SimpleNamespace(get_available_providers=lambda: [CUDA, CPU])
        for answer in (False, True):
            driver = Mock(return_value=answer)
            self.assertEqual(device.probe_runtime(ort=ort, driver_probe=driver).ort_cuda, answer)
            driver.assert_called_once_with()
        self.assertFalse(device.probe_runtime(ort=ort, driver_probe=Mock(side_effect=OSError())).ort_cuda)

    def test_probe_errors_and_missing_dependencies_are_cpu(self):
        with patch.dict(sys.modules, {'onnxruntime': None, 'torch': None}):
            self.assertEqual(device.probe_runtime(include_torch=True), device.RuntimeDevice())
        ort = SimpleNamespace(get_available_providers=Mock(side_effect=RuntimeError('private')))
        self.assertEqual(device.probe_runtime(ort=ort), device.RuntimeDevice())

    def test_driver_probe_has_timeout_and_discards_output(self):
        runner = Mock(side_effect=subprocess.TimeoutExpired('probe', 2))
        self.assertFalse(device.cuda_driver_available(run=runner))
        self.assertEqual(runner.call_args.kwargs['timeout'], 2)
        self.assertIs(runner.call_args.kwargs['stdout'], subprocess.DEVNULL)
        self.assertIs(runner.call_args.kwargs['stderr'], subprocess.DEVNULL)
        self.assertIn('-B', runner.call_args.args[0])

    def test_driver_exit_code_controls_selection_without_output(self):
        for code in (0, 1, 2):
            self.assertEqual(device.cuda_driver_available(run=Mock(return_value=SimpleNamespace(returncode=code))), code == 0)

    def test_torch_probe_precedes_load_and_does_not_depend_on_ort(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=Mock(return_value=True)))
        ort = SimpleNamespace(get_available_providers=lambda: [CPU])
        result = device.probe_runtime(include_torch=True, ort=ort, torch=torch)
        self.assertEqual(result, device.RuntimeDevice(torch_cuda=True))
        torch.cuda.is_available.assert_called_once_with()

    def test_explicit_cuda_session_disables_both_fallbacks(self):
        selected = session([CUDA, CPU])
        ort = SimpleNamespace(InferenceSession=Mock(return_value=selected))
        loaded, code = device.create_onnx_session(ort, 'fixture.onnx', device.RuntimeDevice(ort_cuda=True))
        self.assertIs(loaded, selected)
        self.assertEqual(code, 'cuda')
        self.assertEqual(ort.InferenceSession.call_args.kwargs['providers'], [CUDA, CPU])
        self.assertFalse(ort.InferenceSession.call_args.kwargs['enable_fallback'])
        selected.disable_fallback.assert_called_once_with()

    def test_cuda_failure_has_one_fresh_cpu_initialization(self):
        cpu = session([CPU])
        ort = SimpleNamespace(InferenceSession=Mock(side_effect=[RuntimeError('CUDA DLL unavailable private'), cpu]))
        self.assertEqual(device.create_onnx_session(ort, 'fixture', device.RuntimeDevice(ort_cuda=True)), (cpu, 'cpu'))
        self.assertEqual(ort.InferenceSession.call_count, 2)
        self.assertEqual(ort.InferenceSession.call_args.kwargs['providers'], [CPU])

    def test_silent_fallback_is_truthful_without_reinitialization(self):
        cpu = session([CPU])
        ort = SimpleNamespace(InferenceSession=Mock(return_value=cpu))
        self.assertEqual(device.create_onnx_session(ort, 'fixture', device.RuntimeDevice(ort_cuda=True)), (cpu, 'cpu'))
        ort.InferenceSession.assert_called_once()

    def test_cpu_failure_after_cuda_failure_is_not_retried_again(self):
        ort = SimpleNamespace(InferenceSession=Mock(side_effect=[RuntimeError('CUDA failure 35'), ValueError('bad graph')]))
        with self.assertRaises(ValueError):
            device.create_onnx_session(ort, 'fixture', device.RuntimeDevice(ort_cuda=True))
        self.assertEqual(ort.InferenceSession.call_count, 2)

    def test_asset_errors_and_cpu_errors_are_not_retried(self):
        class InvalidProtobuf(RuntimeError):
            pass
        for error in (InvalidProtobuf('CUDA in private path'), ValueError('bad asset'),
                      RuntimeError('invalid graph'), RuntimeError('invalid graph at private/CUDA/model'),
                      FileNotFoundError('private')):
            ort = SimpleNamespace(InferenceSession=Mock(side_effect=error))
            with self.subTest(error=type(error).__name__), self.assertRaises(type(error)):
                device.create_onnx_session(ort, 'fixture', device.RuntimeDevice(ort_cuda=True))
            ort.InferenceSession.assert_called_once()
        ort = SimpleNamespace(InferenceSession=Mock(side_effect=RuntimeError('CUDA private')))
        with self.assertRaises(RuntimeError):
            device.create_onnx_session(ort, 'fixture', device.RuntimeDevice())
        ort.InferenceSession.assert_called_once()

    def test_model_fallback_does_not_mutate_shared_candidate(self):
        candidate = device.RuntimeDevice(ort_cuda=True)
        ort = SimpleNamespace(InferenceSession=Mock(side_effect=[session([CPU]), session([CUDA, CPU])]))
        self.assertEqual(device.create_onnx_session(ort, 'detector', candidate)[1], 'cpu')
        self.assertEqual(device.create_onnx_session(ort, 'kokoro', candidate)[1], 'cuda')

    def test_unexpected_registered_providers_are_rejected(self):
        for providers in ([], ['AzureExecutionProvider', CPU], [CUDA]):
            ort = SimpleNamespace(InferenceSession=Mock(return_value=session(providers)))
            with self.subTest(providers=providers), self.assertRaises(ValueError):
                device.create_onnx_session(ort, 'fixture', device.RuntimeDevice(ort_cuda=True))


if __name__ == '__main__':
    unittest.main()
