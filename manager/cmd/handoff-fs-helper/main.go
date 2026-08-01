//go:build linux

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Noyv3x/enterprise-agent-platform/manager/internal/handofftransform"
)

func main() {
	flags := flag.NewFlagSet("handoff-fs-helper", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	request := flags.String("request", "", "fixed owner-control request path")
	receipt := flags.String("receipt", "", "fixed owner-control receipt path")
	if err := flags.Parse(os.Args[1:]); err != nil || flags.NArg() != 0 || *request == "" || *receipt == "" {
		if err == nil {
			err = fmt.Errorf("exactly --request and --receipt are required")
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := handofftransform.RunPrivilegedTreeWorker(ctx, *request, *receipt); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
