//go:build windows

package daemon

import "os"

// redirectStdio no hace nada en Windows: stdout/stderr siguen en el fichero heredado
// (que además impide renombrarlo; RotatingLog lo reintenta cada minuto).
func redirectStdio(*os.File) {}
