import ctypes
import importlib.util
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).parents[1] / 'scripts/close-native-browser.py'
spec = importlib.util.spec_from_file_location('close_native_browser', SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class ClientMessage(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong),
                ('send_event', ctypes.c_int), ('display', ctypes.c_void_p),
                ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('data', ctypes.c_long * 5)]


class Event(ctypes.Union):
    _fields_ = [('client', ClientMessage), ('padding', ctypes.c_long * 24)]


class NativeCloseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('Xvfb'):
            raise RuntimeError('Xvfb is required for native close regression tests')
        cls.x11 = ctypes.CDLL('libX11.so.6')
        signatures = {
            'XOpenDisplay': ([ctypes.c_char_p], ctypes.c_void_p),
            'XDefaultRootWindow': ([ctypes.c_void_p], ctypes.c_ulong),
            'XCreateSimpleWindow': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                    ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong], ctypes.c_ulong),
            'XInternAtom': ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int], ctypes.c_ulong),
            'XChangeProperty': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                 ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
            'XDestroyWindow': ([ctypes.c_void_p, ctypes.c_ulong], ctypes.c_int),
            'XSync': ([ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
            'XPending': ([ctypes.c_void_p], ctypes.c_int),
            'XNextEvent': ([ctypes.c_void_p, ctypes.POINTER(Event)], ctypes.c_int),
            'XConnectionNumber': ([ctypes.c_void_p], ctypes.c_int),
            'XCloseDisplay': ([ctypes.c_void_p], ctypes.c_int),
        }
        for name, (args, result) in signatures.items():
            function = getattr(cls.x11, name)
            function.argtypes, function.restype = args, result
        # stdout is the displayfd: no guessed display or readiness sleep.
        cls.server = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0',
                                       '640x480x24', '-nolisten', 'tcp'],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop_server)
        if not select.select([cls.server.stdout], [], [], 10)[0]:
            raise RuntimeError('Xvfb display allocation timed out')
        number = cls.server.stdout.readline().strip()
        if not number.isdigit():
            raise RuntimeError('Xvfb did not allocate a display')
        cls.display_name = ':' + number.decode('ascii')

    @classmethod
    def stop_server(cls):
        if cls.server.poll() is None:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.server.kill()
                cls.server.wait(timeout=5)
        cls.server.stdout.close()

    def setUp(self):
        self.display = self.x11.XOpenDisplay(self.display_name.encode())
        self.assertTrue(self.display)
        self.addCleanup(self.x11.XCloseDisplay, self.display)
        self.root = self.x11.XDefaultRootWindow(self.display)
        self.pid = os.getpid()
        self.protocols = self.x11.XInternAtom(self.display, b'WM_PROTOCOLS', False)
        self.delete = self.x11.XInternAtom(self.display, b'WM_DELETE_WINDOW', False)
        self.windows = []
        self.addCleanup(self.destroy_windows)

    def destroy_windows(self):
        for window in self.windows:
            self.x11.XDestroyWindow(self.display, window)
        self.x11.XSync(self.display, False)

    def window(self, pid, close=True):
        window = self.x11.XCreateSimpleWindow(self.display, self.root, 0, 0,
                                              100, 100, 0, 0, 0)
        self.windows.append(window)
        pid_atom = self.x11.XInternAtom(self.display, b'_NET_WM_PID', False)
        value = ctypes.c_ulong(pid)
        self.x11.XChangeProperty(self.display, window, pid_atom, 6, 32, 0,
                                 ctypes.byref(value), 1)
        if close:
            protocol = ctypes.c_ulong(self.delete)
            self.x11.XChangeProperty(self.display, window, self.protocols, 4, 32,
                                     0, ctypes.byref(protocol), 1)
        self.x11.XSync(self.display, False)
        return window

    def messages(self, count):
        events = []
        deadline = time.monotonic() + 5
        while len(events) < count:
            while self.x11.XPending(self.display):
                event = Event()
                self.x11.XNextEvent(self.display, ctypes.byref(event))
                if event.client.type == 33:
                    events.append((event.client.window, event.client.message_type,
                                   event.client.format, event.client.data[0]))
            if len(events) >= count:
                break
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, 'close message deadline expired')
            select.select([self.x11.XConnectionNumber(self.display)], [], [], remaining)
        return events

    def cli(self, display=None, pid=None):
        return subprocess.run([sys.executable, '-B', str(SCRIPT),
                               display or self.display_name,
                               str(self.pid if pid is None else pid)],
                              capture_output=True, text=True, timeout=10)

    def test_owned_windows_receive_close_and_other_pid_does_not(self):
        owned = [self.window(self.pid), self.window(self.pid)]
        self.window(self.pid + 100000)
        result = self.cli()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '2\n', ''))
        messages = self.messages(2)
        self.assertCountEqual(messages, [(w, self.protocols, 32, self.delete) for w in owned])
        self.x11.XSync(self.display, False)
        self.assertEqual(self.x11.XPending(self.display), 0)

    def test_no_match_and_missing_close_protocol(self):
        self.window(self.pid + 100000)
        self.window(self.pid, close=False)
        result = self.cli()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '0\n', ''))
        self.x11.XSync(self.display, False)
        self.assertEqual(self.x11.XPending(self.display), 0)

    def test_unavailable_display_and_invalid_pid_contract(self):
        result = self.cli(display='invalid-display')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '0\n', ''))
        for pid in ('secret-marker', 0, 1, -1):
            result = self.cli(pid=pid)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (2, '', 'native_close_helper_error\n'))

    def test_destroyed_window_race_keeps_remaining_owned_window(self):
        disappearing = self.window(self.pid)
        survivor = self.window(self.pid)
        real_cdll = ctypes.CDLL
        library = real_cdll('libX11.so.6')
        original_query = library.XQueryTree

        class QueryTree:
            def __call__(_self, *args):
                result = original_query(*args)
                if args[1] == self.root:
                    self.x11.XDestroyWindow(self.display, disappearing)
                    self.windows.remove(disappearing)
                    self.x11.XSync(self.display, False)
                return result

            def __setattr__(_self, name, value):
                setattr(original_query, name, value)

        library.XQueryTree = QueryTree()
        with mock.patch.object(helper.ctypes, 'CDLL', return_value=library):
            self.assertEqual(helper.close_windows(self.display_name, self.pid), 1)
        self.assertEqual(self.messages(1), [(survivor, self.protocols, 32, self.delete)])

    def test_unexpected_real_x_error_is_safe_cli_failure(self):
        library = ctypes.CDLL('libX11.so.6')
        original_sync = library.XSync
        library.XCreatePixmap.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                          ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
        library.XCreatePixmap.restype = ctypes.c_ulong

        class Sync:
            injected = False

            def __call__(_self, display, discard):
                if not _self.injected:
                    _self.injected = True
                    # Invalid drawable: real BadDrawable outside the race allowlist.
                    library.XCreatePixmap(display, 0, 1, 1, 24)
                return original_sync(display, discard)

            def __setattr__(_self, name, value):
                if name == 'injected':
                    object.__setattr__(_self, name, value)
                else:
                    setattr(original_sync, name, value)

        library.XSync = Sync()
        import contextlib
        import io
        stderr, stdout = io.StringIO(), io.StringIO()
        with mock.patch.object(helper.ctypes, 'CDLL', return_value=library), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = helper.main(['helper', self.display_name, str(self.pid)])
        self.assertEqual((status, stdout.getvalue(), stderr.getvalue()),
                         (2, '', 'native_close_helper_error\n'))


if __name__ == '__main__':
    unittest.main()
