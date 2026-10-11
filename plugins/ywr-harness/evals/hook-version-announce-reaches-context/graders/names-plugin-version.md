---
type: regex
pattern: 'ywr-harness(?:(?!claude code)[^\n]){0,60}?v?\d+\.\d+\.\d+|(?<!claude code\s{0,3}(?:version\s{0,3})?v?)v?\d+\.\d+\.\d+(?:(?!claude code|\bno\b|\bnot\b|n[\x27\u2019]t)[^\n,;:.\u2014\u2013]){0,30}?ywr-harness'
flags: i
---
