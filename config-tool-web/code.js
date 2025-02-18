import crc32 from './crc.js';
import usages from './usages.js';
import examples from './examples.js';

const REPORT_ID_CONFIG = 100;
const STICKY_FLAG = 0x01;
const CONFIG_SIZE = 32;
const CONFIG_VERSION = 4;
const VENDOR_ID = 0xCAFE;
const PRODUCT_ID = 0xBAF2;
const DEFAULT_PARTIAL_SCROLL_TIMEOUT = 1000000;
const DEFAULT_SCALING = 1000;

const NLAYERS = 4;
const NMACROS = 8;
const MACRO_ITEMS_IN_PACKET = 6;

const LAYERS_USAGE_PAGE = 0xFFF10000;

const RESET_INTO_BOOTSEL = 1;
const SET_CONFIG = 2;
const GET_CONFIG = 3;
const CLEAR_MAPPING = 4;
const ADD_MAPPING = 5;
const GET_MAPPING = 6;
const PERSIST_CONFIG = 7;
const GET_OUR_USAGES = 8
const GET_THEIR_USAGES = 9
const SUSPEND = 10;
const RESUME = 11;
const PAIR_NEW_DEVICE = 12;
const CLEAR_BONDS = 13;
const FLASH_B_SIDE = 14;
const CLEAR_MACROS = 15;
const APPEND_TO_MACRO = 16;
const GET_MACRO = 17;

const UINT8 = Symbol('uint8');
const UINT32 = Symbol('uint32');
const INT32 = Symbol('int32');

let device = null;
let modal = null;
let extra_usages = [];
let config = {
    'version': CONFIG_VERSION,
    'unmapped_passthrough_layers': [0, 1, 2, 3],
    'partial_scroll_timeout': DEFAULT_PARTIAL_SCROLL_TIMEOUT,
    'interval_override': 0,
    mappings: [{
        'source_usage': '0x00000000',
        'target_usage': '0x00000000',
        'layers': [0],
        'sticky': false,
        'scaling': DEFAULT_SCALING,
    }],
    macros: [
        [], [], [], [], [], [], [], []
    ],
};
const ignored_usages = new Set([
]);

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("open_device").addEventListener("click", open_device);
    document.getElementById("load_from_device").addEventListener("click", load_from_device);
    document.getElementById("save_to_device").addEventListener("click", save_to_device);
    document.getElementById("add_mapping").addEventListener("click", add_mapping_onclick);
    document.getElementById("download_json").addEventListener("click", download_json);
    document.getElementById("upload_json").addEventListener("click", upload_json);
    document.getElementById("flash_firmware").addEventListener("click", flash_firmware);
    document.getElementById("flash_b_side").addEventListener("click", flash_b_side);
    document.getElementById("pair_new_device").addEventListener("click", pair_new_device);
    document.getElementById("clear_bonds").addEventListener("click", clear_bonds);
    document.getElementById("file_input").addEventListener("change", file_uploaded);

    device_buttons_set_disabled_state(true);

    document.getElementById("partial_scroll_timeout_input").addEventListener("change", partial_scroll_timeout_onchange);
    for (let i = 0; i < NLAYERS; i++) {
        document.getElementById("unmapped_passthrough_checkbox" + i).addEventListener("change", unmapped_passthrough_onchange);
    }
    document.getElementById("interval_override_dropdown").addEventListener("change", interval_override_onchange);

    if ("hid" in navigator) {
        navigator.hid.addEventListener('disconnect', hid_on_disconnect);
    } else {
        display_error("Your browser doesn't support WebHID. Try Chrome (desktop version) or a Chrome-based browser.");
    }

    setup_examples();
    modal = new bootstrap.Modal(document.getElementById('usage_modal'), {});
    setup_usages_modal();
    setup_macros();
    set_ui_state();
});

async function open_device() {
    clear_error();
    let success = false;
    const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]
    }).catch((err) => { display_error(err); });
    const config_interface = devices?.find(d => d.collections.some(c => c.usagePage == 0xff00));
    if (config_interface !== undefined) {
        device = config_interface;
        if (!device.opened) {
            await device.open().catch((err) => { display_error(err + "\nIf you're on Linux, you might need to give yourself permissions to the appropriate /dev/hidraw* device."); });
        }
        success = device.opened;
        success &&= await check_device_version();
        if (success) {
            await get_usages_from_device();
            setup_usages_modal();
            bluetooth_buttons_set_visibility(device.productName.includes("Bluetooth"));
        }
    }

    device_buttons_set_disabled_state(!success);

    if (!success) {
        device = null;
    }
}

async function load_from_device() {
    if (device == null) {
        return;
    }
    clear_error();

    try {
        await send_feature_command(GET_CONFIG);
        const [config_version, flags, partial_scroll_timeout, mapping_count, our_usage_count, their_usage_count, interval_override] =
            await read_config_feature([UINT8, UINT8, UINT32, UINT32, UINT32, UINT32, UINT8]);
        check_received_version(config_version);

        config['version'] = config_version;
        config['unmapped_passthrough_layers'] = mask_to_layer_list(flags & ((1 << NLAYERS) - 1));
        config['partial_scroll_timeout'] = partial_scroll_timeout;
        config['interval_override'] = interval_override;
        config['mappings'] = [];

        for (let i = 0; i < mapping_count; i++) {
            await send_feature_command(GET_MAPPING, [[UINT32, i]]);
            const [target_usage, source_usage, scaling, layer_mask, mapping_flags] =
                await read_config_feature([UINT32, UINT32, INT32, UINT8, UINT8]);
            config['mappings'].push({
                'target_usage': '0x' + target_usage.toString(16).padStart(8, '0'),
                'source_usage': '0x' + source_usage.toString(16).padStart(8, '0'),
                'scaling': scaling,
                'layers': mask_to_layer_list(layer_mask),
                'sticky': (mapping_flags & STICKY_FLAG) != 0,
            });
        }

        config['macros'] = [];

        for (let macro_i = 0; macro_i < NMACROS; macro_i++) {
            let macro = [];
            let i = 0;
            let keep_going = true;
            while (keep_going) {
                await send_feature_command(GET_MACRO, [[UINT32, macro_i], [UINT32, i]]);
                const fields = await read_config_feature([UINT8, UINT32, UINT32, UINT32, UINT32, UINT32, UINT32]);
                const nitems = fields[0];
                const usages = fields.slice(1);
                if (nitems < MACRO_ITEMS_IN_PACKET) {
                    keep_going = false;
                }
                if ((macro.length == 0) && (nitems > 0)) {
                    macro = [[]];
                }
                for (const usage of usages.slice(0, nitems)) {
                    if (usage == 0) {
                        macro.push([]);
                    } else {
                        macro.at(-1).push('0x' + usage.toString(16).padStart(8, '0'));
                    }
                }
                i += MACRO_ITEMS_IN_PACKET;
            }

            config['macros'].push(macro);
        }

        set_ui_state();
    } catch (e) {
        display_error(e);
    }
}

async function save_to_device() {
    if (device == null) {
        return;
    }
    clear_error();

    try {
        await send_feature_command(SUSPEND);
        await send_feature_command(SET_CONFIG, [
            [UINT8, layer_list_to_mask(config['unmapped_passthrough_layers'])],
            [UINT32, config['partial_scroll_timeout']],
            [UINT8, config['interval_override']],
        ]);
        await send_feature_command(CLEAR_MAPPING);

        for (const mapping of config['mappings']) {
            await send_feature_command(ADD_MAPPING, [
                [UINT32, parseInt(mapping['target_usage'], 16)],
                [UINT32, parseInt(mapping['source_usage'], 16)],
                [INT32, mapping['scaling']],
                [UINT8, layer_list_to_mask(mapping['layers'])],
                [UINT8, mapping['sticky'] ? STICKY_FLAG : 0],
            ]);
        }

        await send_feature_command(CLEAR_MACROS);
        let macro_i = 0;
        for (const macro of config['macros']) {
            if (macro_i >= NMACROS) {
                break;
            }

            const flat_zero_separated = macro.map((x) => x.concat(["0x00"])).flat().slice(0, -1);

            for (let i = 0; i < flat_zero_separated.length; i += MACRO_ITEMS_IN_PACKET) {
                const chunk_size = i + MACRO_ITEMS_IN_PACKET > flat_zero_separated.length
                    ? flat_zero_separated.length - i
                    : MACRO_ITEMS_IN_PACKET;
                await send_feature_command(APPEND_TO_MACRO,
                    [[UINT8, macro_i], [UINT8, chunk_size]].concat(
                        flat_zero_separated
                            .slice(i, i + chunk_size)
                            .map((x) => [UINT32, parseInt(x, 16)])));
            }

            macro_i++;
        }

        await send_feature_command(PERSIST_CONFIG);
        await send_feature_command(RESUME);
    } catch (e) {
        display_error(e);
    }
}

async function get_usages_from_device() {
    try {
        await send_feature_command(GET_CONFIG);
        const [config_version, flags, partial_scroll_timeout, mapping_count, our_usage_count, their_usage_count] =
            await read_config_feature([UINT8, UINT8, UINT32, UINT32, UINT32, UINT32]);
        check_received_version(config_version);

        let extra_usage_set = new Set();

        for (const [command, rle_count] of [
            [GET_OUR_USAGES, our_usage_count],
            [GET_THEIR_USAGES, their_usage_count]
        ]) {
            let i = 0;
            while (i < rle_count) {
                await send_feature_command(command, [[UINT32, i]]);
                const fields = await read_config_feature([UINT32, UINT32, UINT32, UINT32, UINT32, UINT32]);

                for (let j = 0; j < 3; j++) {
                    const usage = fields[2 * j];
                    const count = fields[2 * j + 1];
                    if (usage != 0) {
                        for (let k = 0; k < count; k++) {
                            const u = '0x' + (usage + k).toString(16).padStart(8, '0');
                            if (!(u in usages) && !ignored_usages.has(u)) {
                                extra_usage_set.add(u);
                            }
                        }
                    }
                }

                i += 3;
            }
        }

        extra_usages = Array.from(extra_usage_set);
        extra_usages.sort();
    } catch (e) {
        display_error(e);
    }
}

function set_config_ui_state() {
    document.getElementById('partial_scroll_timeout_input').value = Math.round(config['partial_scroll_timeout'] / 1000);
    for (let i = 0; i < NLAYERS; i++) {
        document.getElementById('unmapped_passthrough_checkbox' + i).checked =
            config['unmapped_passthrough_layers'].includes(i);
    }
    document.getElementById('interval_override_dropdown').value = config['interval_override'];
}

function set_mappings_ui_state() {
    clear_children(document.getElementById('mappings'));
    for (const mapping of config['mappings']) {
        add_mapping(mapping);
    }
}

function set_macros_ui_state() {
    let macro_i = 0;
    for (const macro of config['macros']) {
        if (macro_i >= NMACROS) {
            break;
        }

        const macro_element = document.getElementById('macro_' + macro_i);
        const macro_entries = macro_element.querySelector('.macro_entries');
        clear_children(macro_entries);
        for (const entry of macro) {
            const entry_element = add_macro_entry(macro_element);
            for (const item of entry) {
                const item_element = add_macro_item(entry_element);
                const usage_button_element = item_element.querySelector('.macro_item_usage');
                usage_button_element.innerText = readable_usage_name(item);
                usage_button_element.setAttribute('data-hid-usage', item);
            }
            if (entry.length == 0) {
                add_macro_item(entry_element);
            }
        }

        macro_i++;
    }
    set_macro_previews();
}

function set_macro_previews() {
    for (let i = 0; i < NMACROS; i++) {
        const macro_element = document.getElementById('macro_' + i);
        const preview = Array.from(macro_element.querySelectorAll('.macro_entry'),
            (entry_element) => Array.from(entry_element.querySelectorAll('.macro_item_usage'),
                (item_element) => item_element.innerText == "Nothing" ? "∅" : item_element.innerText
            ).join('+')).join(', ');
        macro_element.querySelector('.macro_preview').innerText = preview;
    }
}

function set_ui_state() {
    if (config['version'] == 3) {
        config['unmapped_passthrough_layers'] = config['unmapped_passthrough'] ? [0] : [];
        delete config['unmapped_passthrough'];
        for (const mapping of config['mappings']) {
            mapping['layers'] = [mapping['layer']];
            delete mapping['layer'];
        }
        config['macros'] = [ [], [], [], [], [], [], [], [] ];
        config['version'] = CONFIG_VERSION;
    }

    set_config_ui_state();
    set_mappings_ui_state();
    set_macros_ui_state();
}

function add_mapping(mapping) {
    const template = document.getElementById("mapping_template");
    const container = document.getElementById("mappings");
    const clone = template.content.cloneNode(true).firstElementChild;
    clone.querySelector(".delete_button").addEventListener("click", delete_mapping(mapping, clone));
    const sticky_checkbox = clone.querySelector(".sticky_checkbox");
    sticky_checkbox.checked = mapping['sticky'];
    sticky_checkbox.addEventListener("change", sticky_onclick(mapping, sticky_checkbox));
    const scaling_input = clone.querySelector(".scaling_input");
    scaling_input.value = mapping['scaling'] / 1000;
    scaling_input.addEventListener("input", scaling_onchange(mapping, scaling_input));
    for (let i = 0; i < NLAYERS; i++) {
        const layer_checkbox = clone.querySelector(".layer_checkbox" + i);
        layer_checkbox.checked = mapping['layers'].includes(i);
        layer_checkbox.addEventListener("change", layer_checkbox_onchange(mapping, layer_checkbox, i));
    }
    const source_button = clone.querySelector(".source_button");
    source_button.innerText = readable_usage_name(mapping['source_usage']);
    source_button.setAttribute('data-hid-usage', mapping['source_usage']);
    source_button.addEventListener("click", show_usage_modal(mapping, 'source', source_button));
    const target_button = clone.querySelector(".target_button");
    target_button.innerText = readable_usage_name(mapping['target_usage']);
    target_button.setAttribute('data-hid-usage', mapping['target_usage']);
    target_button.addEventListener("click", show_usage_modal(mapping, 'target', target_button));
    container.appendChild(clone);
}

function download_json() {
    clear_error();
    let element = document.createElement('a');
    element.setAttribute('href', 'data:application/json,' + encodeURIComponent(JSON.stringify(config, null, 4)));
    element.setAttribute('download', 'hid-remapper-config.json');

    element.style.display = 'none';
    document.body.appendChild(element);

    element.click();

    document.body.removeChild(element);
}

function upload_json() {
    clear_error();
    document.getElementById("file_input").click();
}

async function flash_firmware() {
    display_error("HID Remapper should now be in firmware flashing mode. Copy UF2 file to the drive that appeared. If you don't want to flash new firmware at this time, just unplug and replug the device.");
    await send_feature_command(RESET_INTO_BOOTSEL);
}

async function flash_b_side() {
    display_error("Side B should now be flashed with firmware version matching side A. Disconnect and reconnect the device.");
    await send_feature_command(FLASH_B_SIDE);
}

async function pair_new_device() {
    await send_feature_command(PAIR_NEW_DEVICE);
}

async function clear_bonds() {
    await send_feature_command(CLEAR_BONDS);
}

function file_uploaded() {
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const new_config = JSON.parse(e.target.result);
            check_json_version(new_config['version']);
            config = new_config;
            set_ui_state();
        } catch (e) {
            display_error(e);
        }
    };

    const file = document.getElementById("file_input").files[0];
    if (file !== undefined) {
        reader.readAsText(file);
    }

    document.getElementById("file_input").value = '';
}

async function send_feature_command(command, fields = [], version = CONFIG_VERSION) {
    let buffer = new ArrayBuffer(CONFIG_SIZE);
    let dataview = new DataView(buffer);
    dataview.setUint8(0, version);
    dataview.setUint8(1, command);
    let pos = 2;
    for (const [type, value] of fields) {
        switch (type) {
            case UINT8:
                dataview.setUint8(pos, value);
                pos += 1;
                break;
            case UINT32:
                dataview.setUint32(pos, value, true);
                pos += 4;
                break;
            case INT32:
                dataview.setInt32(pos, value, true);
                pos += 4;
                break;
        }
    }
    add_crc(dataview);

    await device.sendFeatureReport(REPORT_ID_CONFIG, buffer);
}

async function read_config_feature(fields = []) {
    const data_with_report_id = await device.receiveFeatureReport(REPORT_ID_CONFIG);
    const data = new DataView(data_with_report_id.buffer, 1);
    check_crc(data);
    let ret = [];
    let pos = 0;
    for (const type of fields) {
        switch (type) {
            case UINT8:
                ret.push(data.getUint8(pos));
                pos += 1;
                break;
            case UINT32:
                ret.push(data.getUint32(pos, true));
                pos += 4;
                break;
            case INT32:
                ret.push(data.getInt32(pos, true));
                pos += 4;
                break;
        }
    }
    return ret;
}

function clear_error() {
    document.getElementById("error").classList.add("d-none");
}

function display_error(message) {
    document.getElementById("error").innerText = message;
    document.getElementById("error").classList.remove("d-none");
}

function display_error_html(message) {
    document.getElementById("error").innerHTML = message;
    document.getElementById("error").classList.remove("d-none");
}

function check_crc(data) {
    if (data.getUint32(CONFIG_SIZE - 4, true) != crc32(data, CONFIG_SIZE - 4)) {
        throw new Error('CRC error.');
    }
}

function add_crc(data) {
    data.setUint32(CONFIG_SIZE - 4, crc32(data, CONFIG_SIZE - 4), true);
}

function check_json_version(config_version) {
    if (!([3, 4].includes(config_version))) {
        throw new Error("Incompatible version.");
    }
}

function check_received_version(config_version) {
    if (config_version != CONFIG_VERSION) {
        throw new Error("Incompatible version.");
    }
}

async function check_device_version() {
    // This isn't a reliable way of checking the config version of the device because
    // it could be version X, ignore our GET_CONFIG call with version Y and just happen
    // to have Y at the right place in the buffer from some previous call done by some
    // other software.
    for (const version of [CONFIG_VERSION, 3, 2]) {
        await send_feature_command(GET_CONFIG, [], version);
        const [received_version] = await read_config_feature([UINT8]);
        if (received_version == version) {
            if (version == CONFIG_VERSION) {
                return true;
            }
            display_error_html('<p>Incompatible version (' + version + ').</p>' +
                '<p>Please consider upgrading your HID Remapper firmware to the <a href="https://github.com/jfedor2/hid-remapper/releases/latest">latest version</a>.</p>' +
                '<p class="mb-0">Alternatively, click <a href="v' + version + '/">here</a> for an older version of the configuration tool that should be compatible with your device.</p>');
            return false;
        }
    }

    display_error_html('<p>Incompatible version.</p><p class="mb-0">Please consider upgrading your HID Remapper firmware to the <a href="https://github.com/jfedor2/hid-remapper/releases/latest">latest version</a>.</p>');
    return false;
}

function clear_children(element) {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

function delete_mapping(mapping, element) {
    return function () {
        config['mappings'] = config['mappings'].filter(x => x !== mapping);
        document.getElementById("mappings").removeChild(element);
    };
}

function sticky_onclick(mapping, element) {
    return function () {
        mapping['sticky'] = element.checked;
    };
}

function scaling_onchange(mapping, element) {
    return function () {
        mapping['scaling'] = element.value === '' ? DEFAULT_SCALING : Math.round(parseFloat(element.value) * 1000);
    };
}

function layer_checkbox_onchange(mapping, element, layer) {
    return function () {
        if (element.checked) {
            if (!mapping['layers'].includes(layer)) {
                mapping['layers'].push(layer)
                mapping['layers'].sort();
            }
        } else {
            mapping['layers'] = mapping['layers'].filter((x) => x != layer);
        }
    };
}

function show_usage_modal(mapping, source_or_target, element) {
    return function () {
        document.querySelector('.usage_modal_title').innerText = "Select " + (source_or_target == 'source' ? "input" : "output");
        // XXX it would be better not to do this every time we show the modal
        document.querySelectorAll('.usage_button').forEach((button) => {
            let clone = button.cloneNode(true);
            button.parentNode.replaceChild(clone, button); // to clear existing event listeners
            clone.addEventListener("click", function () {
                let usage = clone.getAttribute('data-hid-usage');
                if (mapping !== null) {
                    mapping[source_or_target + '_usage'] = usage;
                }
                element.innerText = readable_usage_name(usage);

                if (source_or_target == "target") {
                    const mapping_container = element.closest(".mapping_container");
                    for (let i = 0; i < NLAYERS; i++) {
                        mapping_container.querySelector(".layer_checkbox" + i).disabled = false;
                    }
                    const usage_int = parseInt(usage, 16);
                    if (((usage_int & 0xFFFF0000) >>> 0) == LAYERS_USAGE_PAGE) {
                        const layer = usage_int & 0xFFFF;
                        if (!mapping['layers'].includes(layer)) {
                            mapping['layers'].push(layer)
                            mapping['layers'].sort();
                        }
                        const layer_checkbox = mapping_container.querySelector(".layer_checkbox" + layer);
                        layer_checkbox.checked = true;
                        layer_checkbox.disabled = true;
                    }
                }

                if (source_or_target == "macro_item") {
                    element.setAttribute('data-hid-usage', usage);
                    set_macros_config_from_ui_state();
                }

                modal.hide();
            });
        });
        modal.show();
    };
}

function add_mapping_onclick() {
    let new_mapping = {
        'source_usage': '0x00000000',
        'target_usage': '0x00000000',
        'layers': [0],
        'sticky': false,
        'scaling': DEFAULT_SCALING
    };
    config['mappings'].push(new_mapping);
    add_mapping(new_mapping);
}

function setup_usages_modal() {
    let usage_classes = {
        'mouse': document.querySelector('.mouse_usages'),
        'keyboard': document.querySelector('.keyboard_usages'),
        'media': document.querySelector('.media_usages'),
        'other': document.querySelector('.other_usages'),
        'extra': document.querySelector('.extra_usages'),
    };
    for (const [usage_class, element] of Object.entries(usage_classes)) {
        clear_children(element);
    }
    let template = document.getElementById('usage_button_template');
    for (const [usage, usage_def] of Object.entries(usages)) {
        let clone = template.content.cloneNode(true).firstElementChild;
        clone.innerText = usage_def['name'];
        clone.setAttribute('data-hid-usage', usage);
        usage_classes[usage_def['class']].appendChild(clone);
    }
    for (const usage_ of extra_usages) {
        let clone = template.content.cloneNode(true).firstElementChild;
        clone.innerText = usage_;
        clone.setAttribute('data-hid-usage', usage_);
        usage_classes['extra'].appendChild(clone);
    }
}

function setup_macros() {
    const macros_container = document.getElementById('macros_container');
    let template = document.getElementById('macro_template');
    for (let i = 0; i < NMACROS; i++) {
        let clone = template.content.cloneNode(true).firstElementChild;
        clone.id = 'macro_' + i;
        clone.querySelector('.accordion-button').setAttribute('data-bs-target', '#collapse_' + i);
        clone.querySelector('.accordion-button').querySelector('.macro_name').innerText = 'Macro ' + (i + 1);
        clone.querySelector('.accordion-collapse').id = 'collapse_' + i;
        clone.querySelector('.add_macro_entry').addEventListener("click", () => {
            const entry_element = add_macro_entry(clone);
            add_macro_item(entry_element);
            set_macros_config_from_ui_state();
        });
        macros_container.appendChild(clone);
    }
}

function add_macro_entry(element) {
    const template = document.getElementById('macro_entry_template');
    const clone = template.content.cloneNode(true).firstElementChild;
    clone.querySelector('.add_macro_item').addEventListener("click", () => {
        add_macro_item(clone);
        set_macros_config_from_ui_state();
    });
    element.querySelector('.macro_entries').appendChild(clone);
    return clone;
}

function add_macro_item(element) {
    const template = document.getElementById('macro_item_template');
    const clone = template.content.cloneNode(true).firstElementChild;
    const button = clone.querySelector('.macro_item_usage');
    button.addEventListener("click", show_usage_modal(null, 'macro_item', button));
    clone.querySelector('.delete_macro_item').addEventListener("click", () => {
        delete_macro_item(clone);
        set_macros_config_from_ui_state();
    });
    element.insertBefore(clone, element.querySelector(".add_item_container"));
    return clone;
}

function delete_macro_item(element) {
    const parent = element.parentNode;
    parent.removeChild(element);
    if (parent.querySelectorAll('.macro_item').length == 0) {
        const macro_entry = parent.closest('.macro_entry');
        macro_entry.parentNode.removeChild(macro_entry);
    }
}

function set_macros_config_from_ui_state() {
    config['macros'] = [];
    for (let i = 0; i < NMACROS; i++) {
        let macro = [];
        const macro_element = document.querySelector('#macro_' + i);
        for (const entry_element of macro_element.querySelectorAll('.macro_entry')) {
            let entry = [];
            for (const item_element of entry_element.querySelectorAll('.macro_item_usage')) {
                const usage = item_element.getAttribute('data-hid-usage');
                if (usage != '0x00000000') {
                    entry.push(usage);
                }
            }
            macro.push(entry);
        }
        config['macros'].push(macro);
    }

    set_macro_previews();
}

function partial_scroll_timeout_onchange() {
    let value = document.getElementById('partial_scroll_timeout_input').value;
    if (value === '') {
        value = DEFAULT_PARTIAL_SCROLL_TIMEOUT;
    } else {
        value = Math.round(value * 1000);
    }
    config['partial_scroll_timeout'] = value;
}

function unmapped_passthrough_onchange() {
    config['unmapped_passthrough_layers'] = [];
    for (let i = 0; i < NLAYERS; i++) {
        if (document.getElementById("unmapped_passthrough_checkbox" + i).checked) {
            config['unmapped_passthrough_layers'].push(i);
        }
    }
}

function interval_override_onchange() {
    config['interval_override'] = parseInt(document.getElementById("interval_override_dropdown").value, 10);
}

function load_example(n) {
    config = structuredClone(examples[n]['config']);
    set_ui_state();
}

function setup_examples() {
    const element = document.getElementById("examples");
    const template = document.getElementById("example_template");
    for (let i = 0; i < examples.length; i++) {
        if (i > 0) {
            element.appendChild(document.createTextNode(', '));
        }
        const clone = template.content.cloneNode(true).firstElementChild;
        clone.innerText = examples[i]['description'];
        clone.addEventListener("click", () => load_example(i));
        element.appendChild(clone);
    }
    element.appendChild(document.createTextNode('.'));
}

function hid_on_disconnect(event) {
    if (event.device === device) {
        device = null;
        device_buttons_set_disabled_state(true);
    }
}

function device_buttons_set_disabled_state(state) {
    document.getElementById("load_from_device").disabled = state;
    document.getElementById("save_to_device").disabled = state;
    document.getElementById("flash_firmware").disabled = state;
    document.getElementById("flash_b_side").disabled = state;
    document.getElementById("pair_new_device").disabled = state;
    document.getElementById("clear_bonds").disabled = state;
}

function bluetooth_buttons_set_visibility(visible) {
    document.getElementById("pair_new_device_container").classList.toggle("d-none", !visible);
    document.getElementById("clear_bonds_container").classList.toggle("d-none", !visible);
    document.getElementById("flash_b_side_container").classList.toggle("d-none", visible);
}

function mask_to_layer_list(layer_mask) {
    let layers = [];
    for (let i = 0; i < NLAYERS; i++) {
        if ((layer_mask & (1 << i)) != 0) {
            layers.push(i);
        }
    }
    return layers;
}

function layer_list_to_mask(layers) {
    let layer_mask = 0;

    for (const layer of layers) {
        layer_mask |= (1 << layer);
    }

    return layer_mask;
}

function readable_usage_name(usage) {
    return (usage in usages) ? usages[usage]['name'] : usage;
}
