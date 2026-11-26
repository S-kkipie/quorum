//go:build linux

package daemon

import (
	"os"
	"strconv"
	"strings"
)

// fileHolders lists the processes that hold the resolved file open, by scanning /proc/<pid>/fd.
// The bool is false when /proc cannot be read.
func fileHolders(resolved string) ([]procInfo, bool) {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil, false
	}
	out := []procInfo{}
	scanned := false
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 || pid == os.Getpid() {
			continue
		}
		dir := "/proc/" + e.Name() + "/fd"
		fds, err := os.ReadDir(dir)
		if err != nil {
			continue // not ours or gone
		}
		scanned = true
		held := false
		for _, fd := range fds {
			if t, err := os.Readlink(dir + "/" + fd.Name()); err == nil && t == resolved {
				held = true
				break
			}
		}
		if !held {
			continue
		}
		if state, cpu, ok := procStat(pid); ok {
			out = append(out, procInfo{Pid: pid, State: state, CPUMs: cpu})
		}
	}
	if !scanned {
		// not even our own fds were readable: /proc is not usable
		if _, err := os.ReadDir("/proc/self/fd"); err != nil {
			return nil, false
		}
	}
	return out, true
}

// procStat reads the state letter and CPU time (utime+stime, 100 ticks/s) from /proc/<pid>/stat.
func procStat(pid int) (state string, cpuMs int64, ok bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", 0, false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return "", 0, false
	}
	// after ")": state(3) ppid(4) ... utime(14) stime(15)
	f := strings.Fields(s[i+1:])
	if len(f) < 13 {
		return "", 0, false
	}
	ut, err1 := strconv.ParseInt(f[11], 10, 64)
	st, err2 := strconv.ParseInt(f[12], 10, 64)
	if err1 != nil || err2 != nil {
		return "", 0, false
	}
	return f[0], (ut + st) * 1000 / 100, true
}
