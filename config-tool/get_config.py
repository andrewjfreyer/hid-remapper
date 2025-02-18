#!/usr/bin/env python3

from common import *

import struct
import json

device = get_device()

data = struct.pack("<BBB26B", REPORT_ID_CONFIG, CONFIG_VERSION, GET_CONFIG, *([0] * 26))
device.send_feature_report(add_crc(data))

data = device.get_feature_report(REPORT_ID_CONFIG, CONFIG_SIZE + 1)

(
    report_id,
    version,
    flags,
    partial_scroll_timeout,
    mapping_count,
    our_usage_count,
    their_usage_count,
    interval_override,
    *_,
    crc,
) = struct.unpack("<BBBLLLLB9BL", data)
check_crc(data, crc)

config = {
    "version": version,
    "unmapped_passthrough_layers": mask_to_layer_list(flags & ((1 << NLAYERS) - 1)),
    "partial_scroll_timeout": partial_scroll_timeout,
    "interval_override": interval_override,
    "mappings": [],
    "macros": [],
}

for i in range(mapping_count):
    data = struct.pack(
        "<BBBL22B", REPORT_ID_CONFIG, CONFIG_VERSION, GET_MAPPING, i, *([0] * 22)
    )
    device.send_feature_report(add_crc(data))
    data = device.get_feature_report(REPORT_ID_CONFIG, CONFIG_SIZE + 1)
    (
        report_id,
        target_usage,
        source_usage,
        scaling,
        layer_mask,
        flags,
        *_,
        crc,
    ) = struct.unpack("<BLLlBB14BL", data)
    check_crc(data, crc)
    config["mappings"].append(
        {
            "target_usage": "{0:#010x}".format(target_usage),
            "source_usage": "{0:#010x}".format(source_usage),
            "scaling": scaling,
            "layers": mask_to_layer_list(layer_mask),
            "sticky": (flags & 0x01) != 0,
        }
    )

for macro_i in range(NMACROS):
    macro = []
    i = 0
    keep_going = True
    while keep_going:
        data = struct.pack(
            "<BBBLL18B",
            REPORT_ID_CONFIG,
            CONFIG_VERSION,
            GET_MACRO,
            macro_i,
            i,
            *([0] * 18)
        )
        device.send_feature_report(add_crc(data))
        data = device.get_feature_report(REPORT_ID_CONFIG, CONFIG_SIZE + 1)
        (
            report_id,
            nitems,
            *usages,
            crc,
        ) = struct.unpack("<BB6L3BL", data)
        check_crc(data, crc)
        if nitems < MACRO_ITEMS_IN_PACKET:
            keep_going = False
        if (len(macro) == 0) and (nitems > 0):
            macro = [[]]
        for usage in usages[0:nitems]:
            if usage == 0:
                macro.append([])
            else:
                macro[-1].append("{0:#010x}".format(usage))
        i += MACRO_ITEMS_IN_PACKET
    config["macros"].append(macro)

print(json.dumps(config, indent=2))
