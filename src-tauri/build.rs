use std::{env, fs, path::Path};

fn build_mobitool() {
    let root = Path::new("vendor/libmobi");
    let source = root.join("src");
    let tools = root.join("tools");
    println!("cargo:rerun-if-changed={}", root.display());

    let target = env::var("TARGET").expect("Cargo target");
    let windows = target.contains("windows");
    let extension = if windows { ".exe" } else { "" };
    let name = format!("leaf-mobitool-{target}{extension}");
    let directory =
        std::path::PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let output = directory.join(&name);
    let mut build = cc::Build::new();
    build.opt_level(2).debug(false);
    let compiler = build.get_compiler();
    let mut command = compiler.to_command();
    if compiler.is_like_msvc() {
        command.arg(format!("/I{}", source.display()));
        command.args([
            "/D_CRT_SECURE_NO_WARNINGS",
            "/DUSE_XMLWRITER",
            "/DUSE_MINIZ",
        ]);
        command.arg(format!("/Fe{}", output.display()));
        command.arg(format!("/Fo{}/", directory.display()));
    } else {
        command.arg("-I").arg(&source);
        command.args(["-D_GNU_SOURCE", "-DUSE_XMLWRITER", "-DUSE_MINIZ"]);
        command.arg("-o").arg(&output);
    }
    if windows {
        command.arg(tools.join("win32/getopt.c"));
    } else {
        command.args(["-DHAVE_UNISTD_H", "-DHAVE_GETOPT", "-DHAVE_STRDUP"]);
    }
    for unit in [
        "buffer",
        "compression",
        "debug",
        "index",
        "memory",
        "meta",
        "parse_rawml",
        "read",
        "structure",
        "util",
        "write",
        "opf",
        "xmlwriter",
        "miniz",
    ] {
        command.arg(source.join(format!("{unit}.c")));
    }
    command
        .arg(tools.join("common.c"))
        .arg(tools.join("mobitool.c"));
    assert!(
        command
            .status()
            .expect("start C compiler for mobitool")
            .success(),
        "could not build mobitool"
    );

    // Tauri copies and signs the target-specific helper as a separate executable.
    let binaries = Path::new("binaries");
    fs::create_dir_all(binaries).expect("create sidecar directory");
    let destination = binaries.join(&name);
    if fs::read(&destination).ok() != fs::read(&output).ok() {
        fs::copy(&output, &destination).expect("stage mobitool for Tauri");
    }
    println!("cargo:rustc-env=LEAF_TEST_MOBITOOL={}", output.display());
}

fn main() {
    build_mobitool();
    tauri_build::build();
}
