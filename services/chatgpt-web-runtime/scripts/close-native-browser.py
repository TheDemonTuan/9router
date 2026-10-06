#!/usr/bin/env python3
"""Ask only the owned Chrome PID's X11 windows to close and flush their profile."""
import ctypes
import sys

class XErrorEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("display", ctypes.c_void_p),
                ("resourceid", ctypes.c_ulong), ("serial", ctypes.c_ulong),
                ("error_code", ctypes.c_ubyte), ("request_code", ctypes.c_ubyte),
                ("minor_code", ctypes.c_ubyte)]



def close_windows(display_name, pid):
    x11 = ctypes.CDLL("libX11.so.6")
    window = ctypes.c_ulong
    atom = ctypes.c_ulong
    pointer = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = pointer
    x11.XDefaultRootWindow.argtypes = [pointer]
    x11.XDefaultRootWindow.restype = window
    x11.XInternAtom.argtypes = [pointer, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = atom
    x11.XQueryTree.argtypes = [pointer, window, ctypes.POINTER(window), ctypes.POINTER(window), ctypes.POINTER(ctypes.POINTER(window)), ctypes.POINTER(ctypes.c_uint)]
    x11.XGetWindowProperty.argtypes = [pointer, window, atom, ctypes.c_long, ctypes.c_long, ctypes.c_int, atom, ctypes.POINTER(atom), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(pointer)]
    x11.XFree.argtypes = [pointer]
    x11.XFlush.argtypes = [pointer]
    x11.XCloseDisplay.argtypes = [pointer]
    x11.XSync.argtypes = [pointer, ctypes.c_int]
    error_handler_type = ctypes.CFUNCTYPE(ctypes.c_int, pointer, ctypes.POINTER(XErrorEvent))
    x11.XSetErrorHandler.argtypes = [pointer]
    x11.XSetErrorHandler.restype = pointer
    unexpected_errors = []

    def on_error(_display, event):
        error = event.contents
        if not (error.error_code == 3 and error.request_code in (15, 20, 25)):
            unexpected_errors.append((error.error_code, error.request_code))
        return 0

    # Keep the callback alive until all asynchronous errors have been drained.
    error_handler = error_handler_type(on_error)

    class Data(ctypes.Union):
        _fields_ = [("l", ctypes.c_long * 5)]

    class ClientMessage(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", pointer), ("window", window), ("message_type", atom), ("format", ctypes.c_int), ("data", Data)]

    class Event(ctypes.Union):
        _fields_ = [("client", ClientMessage), ("padding", ctypes.c_long * 24)]

    x11.XSendEvent.argtypes = [pointer, window, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    display = x11.XOpenDisplay(display_name.encode())
    if not display:
        return 0
    previous_handler = x11.XSetErrorHandler(ctypes.cast(error_handler, pointer))
    try:
        pid_atom = x11.XInternAtom(display, b"_NET_WM_PID", False)
        protocols = x11.XInternAtom(display, b"WM_PROTOCOLS", False)
        delete = x11.XInternAtom(display, b"WM_DELETE_WINDOW", False)
        pending = [x11.XDefaultRootWindow(display)]
        closed = 0
        while pending:
            current = pending.pop()
            actual_type, actual_format = atom(), ctypes.c_int()
            items, after, data = ctypes.c_ulong(), ctypes.c_ulong(), pointer()
            try:
                result = x11.XGetWindowProperty(display, current, pid_atom, 0, 1, False, 6, ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(items), ctypes.byref(after), ctypes.byref(data))
                owned = result == 0 and actual_type.value == 6 and actual_format.value == 32 and items.value == 1 and data.value and ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] == pid
            finally:
                if data.value:
                    x11.XFree(data)
            if owned:
                protocol_type, protocol_format = atom(), ctypes.c_int()
                protocol_items, protocol_after, protocol_data = ctypes.c_ulong(), ctypes.c_ulong(), pointer()
                try:
                    protocol_result = x11.XGetWindowProperty(display, current, protocols, 0, 1024, False, 4, ctypes.byref(protocol_type), ctypes.byref(protocol_format), ctypes.byref(protocol_items), ctypes.byref(protocol_after), ctypes.byref(protocol_data))
                    supports_close = protocol_result == 0 and protocol_type.value == 4 and protocol_format.value == 32 and protocol_data.value and delete in ctypes.cast(protocol_data, ctypes.POINTER(ctypes.c_ulong))[:protocol_items.value]
                finally:
                    if protocol_data.value:
                        x11.XFree(protocol_data)
                if not supports_close:
                    continue
                event = Event()
                event.client.type = 33  # ClientMessage
                event.client.display = display
                event.client.window = current
                event.client.message_type = protocols
                event.client.format = 32
                event.client.data.l[0] = delete
                if x11.XSendEvent(display, current, False, 0, ctypes.byref(event)):
                    closed += 1
                continue
            root, parent, children, count = window(), window(), ctypes.POINTER(window)(), ctypes.c_uint()
            try:
                if x11.XQueryTree(display, current, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
                    pending.extend(children[i] for i in range(count.value))
            finally:
                if children:
                    x11.XFree(children)
        x11.XSync(display, False)
        if unexpected_errors:
            raise RuntimeError("native_close_helper_error")
        return closed
    finally:
        try:
            x11.XCloseDisplay(display)
        finally:
            x11.XSetErrorHandler(previous_handler)


def main(argv):
    try:
        if len(argv) != 3:
            raise ValueError("invalid arguments")
        pid = int(argv[2])
        if pid <= 1:
            raise ValueError("invalid PID")
        closed = close_windows(argv[1], pid)
        print(closed)
        return 0 if closed else 1
    except Exception:
        print("native_close_helper_error", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
