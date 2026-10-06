#!/usr/bin/env python3
"""Ask only the owned Chrome PID's X11 windows to close and flush their profile."""
import ctypes
import sys


def close_windows(display_name, pid):
    x11 = ctypes.CDLL("libX11.so.6")
    window = ctypes.c_ulong
    atom = ctypes.c_ulong
    pointer = ctypes.c_void_p
    # Chrome and the window manager can destroy windows while the tree is walked.
    # Xlib's default handler exits the helper on that normal BadWindow race.
    error_handler_type = ctypes.CFUNCTYPE(ctypes.c_int, pointer, pointer)
    error_handler = error_handler_type(lambda _display, _error: 0)
    x11.XSetErrorHandler.argtypes = [error_handler_type]
    x11.XSetErrorHandler(error_handler)
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
            result = x11.XGetWindowProperty(display, current, pid_atom, 0, 1, False, 6, ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(items), ctypes.byref(after), ctypes.byref(data))
            try:
                owned = result == 0 and actual_type.value == 6 and actual_format.value == 32 and items.value == 1 and data.value and ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] == pid
            finally:
                if data.value:
                    x11.XFree(data)
            if owned:
                protocol_type, protocol_format = atom(), ctypes.c_int()
                protocol_items, protocol_after, protocol_data = ctypes.c_ulong(), ctypes.c_ulong(), pointer()
                protocol_result = x11.XGetWindowProperty(display, current, protocols, 0, 1024, False, 4, ctypes.byref(protocol_type), ctypes.byref(protocol_format), ctypes.byref(protocol_items), ctypes.byref(protocol_after), ctypes.byref(protocol_data))
                try:
                    supports_close = protocol_result == 0 and protocol_type.value == 4 and protocol_format.value == 32 and protocol_data.value and delete.value in ctypes.cast(protocol_data, ctypes.POINTER(ctypes.c_ulong))[:protocol_items.value]
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
            if x11.XQueryTree(display, current, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
                try:
                    pending.extend(children[i] for i in range(count.value))
                finally:
                    if children:
                        x11.XFree(children)
        x11.XFlush(display)
        return closed
    finally:
        x11.XCloseDisplay(display)


if __name__ == "__main__":
    pid = int(sys.argv[2])
    if pid <= 1:
        raise ValueError("An owned browser PID is required")
    closed = close_windows(sys.argv[1], pid)
    print(closed)
    sys.exit(0 if closed else 1)
