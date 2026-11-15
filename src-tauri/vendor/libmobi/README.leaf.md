# libmobi

Leaf builds and runs a separate `leaf-mobitool` executable from this subset of
[libmobi](https://github.com/bfabiszewski/libmobi/tree/906274205c11944b628da1c553b255acb1af7c55),
by Bartek Fabiszewski and contributors. The unmodified decoder
and CLI sources are licensed under LGPL-3.0-or-later. For the licenses, see
COPYING and GPL-3.0.txt. miniz retains its upstream notice in miniz.c.

The [Leaf repository](https://github.com/codepiano/leaf-reader) contains the bundled helper sources and
its build recipe in src-tauri/build.rs. The helper is a separate file next
to the Leaf executable and can be replaced with an equivalent build of
mobitool. Leaf builds it without libmobi's encryption option.
