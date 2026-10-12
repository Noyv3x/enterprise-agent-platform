package executor

// sandboxMCPWrapper is the MCP mode of the subreaper supervisor. It keeps the
// design of sandboxBackgroundWrapper (subreaper, own session and process group,
// descendant-confirmed termination, EOF on the supervisor stdin kills the group)
// with these differences:
//
//   - The server's stdout and stderr are separate pipes, forwarded as separate
//     frame streams ("stdout" is the protocol, "stderr" is diagnostics), so
//     protocol bytes can never be mixed with or redacted like logs.
//   - The server is launched with execvpe, never through a shell. Its environment
//     arrives as the first control frame {"t":"env","env":{...}} on the
//     supervisor stdin; nothing secret is ever in argv.
//   - Control frames are {"t":"d","d":<b64>} (server stdin bytes) and
//     {"t":"s","s":<signal>}. There is no input EOF: stdin stays open for the
//     connection's lifetime. An input backlog beyond 4 MiB means the server does
//     not read; it terminates the connection (exit frame input_overflow) instead
//     of masking lifetime EOF the way a paused lease would.
//   - There is no deadline. argv is: command, args...
const sandboxMCPWrapper = `
import base64, ctypes, json, os, select, selectors, signal, sys, time
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0 or sys.exit(125)
command, arguments = sys.argv[1], sys.argv[2:]
control = bytearray()
began = time.monotonic()
while b'\n' not in control:
    if time.monotonic() - began > 10: sys.exit(125)
    if select.select([0], [], [], 0.5)[0]:
        data = os.read(0, 65536)
        if not data: sys.exit(125)
        control.extend(data)
line, _, rest = bytes(control).partition(b'\n')
control[:] = rest
try:
    first = json.loads(line)
    if first.get('t') != 'env': sys.exit(125)
    env = dict(os.environ)
    env.update({str(k): str(v) for k, v in first['env'].items()})
except Exception:
    sys.exit(125)
out_r, out_w = os.pipe()
err_r, err_w = os.pipe()
status_r, status_w = os.pipe()  # close-on-exec: EOF means the server was executed
in_r, in_w = os.pipe()
child = os.fork()
if child == 0:
    os.close(status_r)
    os.setsid()
    os.umask(0o077)
    os.dup2(in_r, 0); os.dup2(out_w, 1); os.dup2(err_w, 2)
    for fd in (out_r, out_w, err_r, err_w, in_r, in_w):
        if fd > 2: os.close(fd)
    try:
        os.execvpe(command, [command] + arguments, env)
    except OSError as error:
        os.write(2, ('cannot execute %s: %s\n' % (command, error.strerror)).encode())
        os.write(status_w, b'1')
        os._exit(127)
os.close(status_w); os.close(out_w); os.close(err_w); os.close(in_r)
os.set_blocking(in_w, False)
exec_failed = os.read(status_r, 1) == b'1'
os.close(status_r)
selector = selectors.DefaultSelector()
selector.register(0, selectors.EVENT_READ, 'lease')
selector.register(out_r, selectors.EVENT_READ, 'stdout')
selector.register(err_r, selectors.EVENT_READ, 'stderr')
status = None
cancelled = False
overflow = False
stopping = None
confirmed = False
pending = bytearray()
def emit(value):
    try:
        sys.stdout.write(json.dumps(value) + '\n'); sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass
def kill_group():
    try: os.killpg(child, signal.SIGKILL)
    except ProcessLookupError: pass
def handle(line):
    try: frame = json.loads(line)
    except ValueError: return
    kind = frame.get('t')
    if kind == 'd' and in_w is not None:
        pending.extend(base64.b64decode(frame.get('d', '')))
    elif kind == 's':
        try: os.killpg(child, int(frame.get('s', 15)))
        except (ProcessLookupError, ValueError, OSError): pass
def drain_control():
    while b'\n' in control:
        line, _, rest = bytes(control).partition(b'\n')
        control[:] = rest
        handle(line)
def pump_stdin():
    global in_w
    while pending and in_w is not None:
        try: written = os.write(in_w, pending[:65536])
        except BlockingIOError: return
        except OSError:
            pending.clear()
            try: os.close(in_w)
            except OSError: pass
            in_w = None
            return
        del pending[:written]
if not exec_failed: emit({'stream': 'started'})
try:
    drain_control()
    while True:
        # Observe without reaping: the leader pins its process-group identity
        # until the only group signal has been sent.
        exited = stopping is None and os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        now = time.monotonic()
        if stopping is None and (cancelled or exited):
            kill_group()
            stopping = now
        if stopping is not None:
            with open('/proc/self/task/%d/children' % os.getpid(), encoding='ascii') as children:
                for pid in map(int, children.read().split()):
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
            while True:
                try: pid, value = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    confirmed = True
                    break
                if pid == 0: break
                if pid == child: status = os.waitstatus_to_exitcode(value)
            if confirmed and all(key.data == 'lease' for key in selector.get_map().values()): break
            if now - stopping >= 2: break
        else:
            pump_stdin()
            if len(pending) > (4 << 20):
                overflow = cancelled = True
        for key, _ in selector.select(timeout=0.02):
            data = os.read(key.fd, 65536)
            if key.data == 'lease':
                if not data:
                    cancelled = True
                    selector.unregister(key.fd)
                    continue
                control.extend(data)
                drain_control()
            elif data:
                for start in range(0, len(data), 32768):
                    emit({'stream': key.data, 'data': base64.b64encode(data[start:start + 32768]).decode('ascii')})
            else:
                selector.unregister(key.fd); os.close(key.fd)
    emit({'stream': 'exit', 'code': status if status is not None else -1, 'confirmed': confirmed, 'cancelled': cancelled, 'input_overflow': overflow})
finally:
    if stopping is None: kill_group()
`
