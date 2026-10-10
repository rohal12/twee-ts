// The oracle behind go-norm-segments.json: the number of segments Go's norm.Iter yields in NFKD, which
// Tweego's word count counts, from golang.org/x/text v0.3.2 (the version Tweego 2.1.1 is built with).
//
// It reads the JSON file named on the command line, recounts the segments of each case's text (code points
// in hexadecimal, separated by spaces) and writes the file back. To run it, put it in a module that requires
// golang.org/x/text v0.3.2:
//
//	go mod init oracle && go get golang.org/x/text@v0.3.2 && go run go-norm-segments.go go-norm-segments.json
package main

import (
	"encoding/json"
	"io/ioutil"
	"os"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

type fixture struct {
	Comment string            `json:"comment"`
	Cases   []json.RawMessage `json:"cases"`
}

func segments(text string) int {
	var it norm.Iter
	it.InitString(norm.NFKD, text)
	n := 0
	for !it.Done() {
		n++
		it.Next()
	}
	return n
}

func main() {
	path := os.Args[1]
	data, err := ioutil.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		panic(err)
	}
	var out strings.Builder
	out.WriteString("{\n  \"comment\": ")
	comment, _ := json.Marshal(f.Comment)
	out.Write(comment)
	out.WriteString(",\n  \"cases\": [\n")
	for i, raw := range f.Cases {
		var c []interface{}
		if err := json.Unmarshal(raw, &c); err != nil {
			panic(err)
		}
		hex := c[0].(string)
		var text strings.Builder
		for _, field := range strings.Fields(hex) {
			cp, err := strconv.ParseUint(field, 16, 32)
			if err != nil {
				panic(err)
			}
			text.WriteRune(rune(cp))
		}
		out.WriteString("    [\"" + hex + "\", " + strconv.Itoa(segments(text.String())) + "]")
		if i < len(f.Cases)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString("  ]\n}\n")
	if err := ioutil.WriteFile(path, []byte(out.String()), 0o644); err != nil {
		panic(err)
	}
}
