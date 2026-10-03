from realbot.config import GameSettings, key_code


def test_options_txt(tmp_path):
    p = tmp_path / 'options.txt'
    p.write_text('mouseSensitivity:0.5\nfov:0.25\nguiScale:3\nfovEffectScale:0.0\nrawMouseInput:true\n'
                 'toggleSprint:false\nkey_key.sprint:key.keyboard.left.shift\nkey_key.jump:key.keyboard.space\n')
    s = GameSettings.load(str(p))
    assert abs(s.fov - 80) < 1e-9
    assert s.gui_scale == 3
    assert s.keys['sprint'] == 'KEY_LEFTSHIFT'
    assert s.keys['forward'] == 'KEY_W'
    assert s.keys['attack'] == 'BTN_LEFT'
    assert s.keys['hotbar1'] == 'KEY_1'
    assert s.problems() == []
    assert abs(s.degrees_per_count() - 0.5 ** 3 * 1.2) < 1e-9  # 0.5*0.6+0.2 = 0.5


def test_problems_and_defaults():
    s = GameSettings({'rawMouseInput': 'false', 'toggleSprint': 'true'})
    assert len(s.problems()) == 3  # raw input, FOV effects (default 100%), toggle sprint
    assert s.effective_gui_scale(1920, 1080) == 4
    assert s.effective_gui_scale(1280, 720) == 3


def test_key_codes():
    assert key_code('key.keyboard.left.control') == 'KEY_LEFTCTRL'
    assert key_code('key.mouse.right') == 'BTN_RIGHT'
    assert key_code('key.keyboard.f') == 'KEY_F'
